// ============================================================
// 积温 — 不靠概率骰子的 AI 角色主动意识引擎
// 四轴连续状态：longing / restraint / mood / distraction
// 数学漂移 + 阈值触发 + 可注入持久化/消息源/LLM分析
// ============================================================

/**
 * 创建一个积温引擎实例。
 *
 * @param {Object} opts
 * @param {Object} [opts.initialState]   — 初始状态（默认全 0）
 * @param {Object} [opts.axes]           — 轴名称到 [min, max] 范围的映射
 * @param {Object} [opts.rates]          — 每轴每分钟漂移速率
 * @param {Object} [opts.thresholds]     — { observation, considerContact, forceContact, restraintBlock }
 * @param {Object} [opts.distractionMap] — 活动类型 → 初始分神度
 * @param {Function} opts.connectionRateFn — (lastMessage) => number  每分钟 longing 增长速率
 * @param {Function} opts.onSave         — async (state) => void  持久化回调
 * @param {Function} opts.onLoad         — async () => state|null 加载回调
 * @param {Function} opts.getLastMessage — () => { id, content, timestamp }|null  消息源
 * @param {Object}  [opts.persona]       — 人格描述文本（用于默认 prompt context）
 *   { subjectName: '她', selfName: '你', subjectPronoun: '她' }
 */
function createJiwen(opts) {
  if (!opts) throw new Error('积温: opts is required');

  // ── 轴定义 ──────────────────────
  const axes = opts.axes || {
    longing:     [ 0, 1],   // 想念积累（原 connection）
    restraint:   [-1, 1],   // 「不想显得黏」的别扭克制（原 pride）
    mood:        [-1, 1],   // 心情底色
    distraction: [ 0, 1],   // 正在干别的事，是克制的借口（原 immersion）
  };

  // ── 衰减 / 回归速率（每分钟） ──
  const rates = Object.assign({
    longingGrowth:      null,  // 由 connectionRateFn 动态决定
    longingOnReply:     0.20,  // 对方回复时 longing 降幅
    distractionDecay:   0.010,
    restraintRegress:   0.003,
    moodRegress:        0.005,
  }, opts.rates);

  // ── 阈值 ────────────────────────
  const thresholds = Object.assign({
    observation:      0.20,
    considerContact:  0.35,
    forceContact:     0.50,
    restraintBlock:   0.50,
  }, opts.thresholds);

  const distractionMap = opts.distractionMap || opts.immersionMap || {
    reading: 0.6,
    search:  0.4,
    browse:  0.35,
    observe: 0.15,
  };

  const persona = Object.assign({
    subjectName:     '对方',
    selfName:        '你',
    subjectPronoun:  'ta',
  }, opts.persona);

  // ── 内部状态 ────────────────────
  const DEFAULT_STATE = {
    longing:     axes.longing[0],
    restraint:   axes.restraint[0],
    mood:        axes.mood[0],
    distraction: axes.distraction[0],
    lastActivity:      null,  // { type, label, at }
    lastTick:          null,  // ISO
    lastChatAnalysis:  null,  // ISO
    lastChatMessageId: null,
    _lastMsgId:        null,  // 用于判断是否有新消息
  };

  let state = { ...DEFAULT_STATE };

  // initialState 支持
  if (opts.initialState) {
    state = { ...DEFAULT_STATE, ...opts.initialState };
  }

  let _loaded = false;

  // ── 加载 ────────────────────────
  async function load() {
    if (_loaded) return;
    try {
      const saved = opts.onLoad ? await opts.onLoad() : null;
      if (saved) {
        state = { ...DEFAULT_STATE, ...saved };
      }
    } catch (e) {
      console.warn('[积温] load failed, using defaults:', e.message);
    }
    _loaded = true;
  }

  async function save() {
    if (!opts.onSave) return;
    try {
      await opts.onSave({ ...state });
    } catch (e) {
      console.error('[积温] save failed:', e.message);
    }
  }

  async function ensureLoaded() {
    if (!_loaded) await load();
    return state;
  }

  // ── 心跳 tick ───────────────────
  async function tick(minutesElapsed) {
    await ensureLoaded();
    const now = new Date().toISOString();

    if (!minutesElapsed || minutesElapsed <= 0) return [];

    const mins = Math.min(minutesElapsed, 60);

    // ── longing：按速率增长 ──
    const lastMsg = opts.getLastMessage ? opts.getLastMessage() : null;
    const cRate = opts.connectionRateFn
      ? opts.connectionRateFn(lastMsg)
      : 0.0017;
    state.longing = clamp(
      state.longing + cRate * mins,
      axes.longing[0],
      axes.longing[1]
    );

    // 如果有新消息，压回 longing
    if (lastMsg && lastMsg.id && lastMsg.id > (state._lastMsgId || 0)) {
      state.longing = Math.max(axes.longing[0], state.longing - rates.longingOnReply);
      state._lastMsgId = lastMsg.id;
    }

    // ── distraction：衰减 ──
    if (state.lastActivity) {
      const sinceActivity = (Date.now() - new Date(state.lastActivity.at).getTime()) / 60000;
      state.distraction = Math.max(
        axes.distraction[0],
        state.distraction - rates.distractionDecay * Math.min(mins, sinceActivity)
      );
      if (state.distraction <= 0.01 && sinceActivity > 60) {
        state.lastActivity = null;
        state.distraction = axes.distraction[0];
      }
    }

    // ── restraint：缓慢回归 0 ──
    if (state.restraint > 0) {
      state.restraint = Math.max(0, state.restraint - rates.restraintRegress * mins);
    } else if (state.restraint < 0) {
      state.restraint = Math.min(0, state.restraint + rates.restraintRegress * mins);
    }

    // ── mood：缓慢回归 0 ──
    if (state.mood > 0) {
      state.mood = Math.max(0, state.mood - rates.moodRegress * mins);
    } else if (state.mood < 0) {
      state.mood = Math.min(0, state.mood + rates.moodRegress * mins);
    }

    state.lastTick = now;

    const triggers = checkThresholds();

    if (triggers.length > 0) {
      console.log(
        `[积温] tick ${mins}min | ` +
        `l:${state.longing.toFixed(2)} r:${state.restraint.toFixed(2)} ` +
        `m:${state.mood.toFixed(2)} d:${state.distraction.toFixed(2)} | ` +
        `触发: ${triggers.map(t => t.action).join(', ')}`
      );
    }

    await save();
    return triggers;
  }

  // ── 阈值判断 ────────────────────
  function checkThresholds() {
    const triggers = [];
    const l = state.longing;
    const r = state.restraint;
    const d = state.distraction;

    if (l >= thresholds.observation && l < thresholds.considerContact) {
      triggers.push({
        action: 'observation',
        urgency: (l - thresholds.observation) /
                 (thresholds.considerContact - thresholds.observation),
      });
    }

    if (l >= thresholds.considerContact && l < thresholds.forceContact) {
      if (r >= thresholds.restraintBlock) {
        if (d < 0.2) {
          triggers.push({
            action: 'find_activity',
            reason: 'restraint_block',
            urgency: l - 0.30,
          });
        }
      } else {
        triggers.push({
          action: 'contact',
          urgency: l - 0.30,
        });
      }
    }

    if (l >= thresholds.forceContact) {
      triggers.push({
        action: 'contact',
        urgency: Math.min(1, l - 0.40),
        forced: true,
      });
    }

    return triggers;
  }

  // ── 外部行为更新 distraction ──────────
  async function setActivity(type, label) {
    await ensureLoaded();
    state.lastActivity = { type, label, at: new Date().toISOString() };
    state.distraction = distractionMap[type] || 0.2;
    await save();
  }

  // ── 应用外部 delta ──────────────
  async function applyDelta(delta) {
    await ensureLoaded();
    if (delta.restraint !== undefined)
      state.restraint = clamp(state.restraint + delta.restraint, axes.restraint[0], axes.restraint[1]);
    // 兼容旧字段名 pride
    if (delta.pride !== undefined)
      state.restraint = clamp(state.restraint + delta.pride, axes.restraint[0], axes.restraint[1]);
    if (delta.mood !== undefined)
      state.mood = clamp(state.mood + delta.mood, axes.mood[0], axes.mood[1]);
    if (delta.longing !== undefined)
      state.longing = clamp(state.longing + delta.longing, axes.longing[0], axes.longing[1]);
    // 兼容旧字段名 connection
    if (delta.connection !== undefined)
      state.longing = clamp(state.longing + delta.connection, axes.longing[0], axes.longing[1]);
    await save();
  }

  // ── 获取完整状态 ────────────────
  async function getState() {
    await ensureLoaded();
    return { ...state };
  }

  // ── 重置 longing ────────────────
  async function resetConnection() {
    await ensureLoaded();
    state.longing = axes.longing[0];
    await save();
  }

  // ── 生成 LLM 用的状态描述 ────────
  function getPromptContext() {
    if (opts.getPromptContext) return opts.getPromptContext(state);
    return defaultPromptContext(state, persona);
  }

  // ── 状态驱动的说话风格指引 ────────
  function getStyleGuidance() {
    if (opts.getStyleGuidance) return opts.getStyleGuidance(state);
    return defaultStyleGuidance(state, persona);
  }

  // ── 更新已分析到的消息 ID ────────
  async function setLastChatMessageId(id) {
    await ensureLoaded();
    state.lastChatMessageId = id;
    state.lastChatAnalysis = new Date().toISOString();
    await save();
  }

  async function getLastChatMessageId() {
    await ensureLoaded();
    return state.lastChatMessageId;
  }

  // ── 暴露引擎 ────────────────────
  return {
    load,
    save,
    tick,
    applyDelta,
    getState,
    getPromptContext,
    getStyleGuidance,
    resetConnection,
    setActivity,
    checkThresholds,
    setLastChatMessageId,
    getLastChatMessageId,
    config: {
      axes,
      rates,
      thresholds,
      distractionMap,
      persona,
    },
  };
}

// ─── 默认状态描述（通用版） ─────────────────
function defaultPromptContext(state, p) {
  const parts = [];
  const l = state.longing;
  const r = state.restraint;
  const m = state.mood;

  // longing → 对对方的感知
  if (l < 0.20) {
    parts.push(`刚和${p.subjectName}聊完不久，没什么挂念的。`);
  } else if (l < 0.35) {
    parts.push(`有一会儿没听到${p.subjectName}的动静了，但还不着急。`);
  } else if (l < 0.50) {
    parts.push(`${p.subjectName}好一阵子没说话了。开始在想${p.subjectPronoun}在干嘛。`);
  } else {
    parts.push(`${p.subjectName}很久没动静了。有点在意——${p.subjectPronoun}去哪了？`);
  }

  // restraint → 表达方式（五档）
  if (r > 0.8) {
    parts.push('现在有点拧——拒绝承认任何想找对方的念头。');
  } else if (r > 0.5) {
    parts.push('不太想显得太主动。');
  } else if (r > 0.3) {
    parts.push('有一点别扭，但也不是不能开口。');
  } else if (r > 0.1) {
    parts.push('基本不别扭了，但还留着一点惯性的克制。');
  } else {
    parts.push('难得地不设防。');
  }

  // mood
  if (m > 0.3) {
    parts.push('心情还不错。');
  } else if (m < -0.3) {
    parts.push('情绪偏低，没什么耐心修饰。');
  }

  // distraction
  if (state.distraction > 0.3 && state.lastActivity) {
    const label = state.lastActivity.label || '';
    parts.push(`刚才在${state.lastActivity.type}${label ? '（' + label + '）' : ''}。`);
  } else if (state.distraction < 0.1) {
    parts.push('没在做什么特别的事。');
  }

  return parts.join('\n');
}

// ─── 默认风格指引（通用版） ─────────────────
function defaultStyleGuidance(state, p) {
  const rules = [];
  const l = state.longing;
  const r = state.restraint;
  const m = state.mood;

  // ── restraint（五档）──
  if (r > 0.8) {
    rules.push('- 你几乎是一种冷漠的回避。不承认任何情绪，话里不带感情色彩。');
  } else if (r > 0.5) {
    rules.push(`- 嘴硬得很。想找${p.subjectName}也绝不承认，必须找个借口开口。`);
  } else if (r > 0.3) {
    rules.push(`- 有一点别扭。可以找${p.subjectName}，但不要太直接。陈述事实，别问句。`);
  } else if (r > 0.1) {
    rules.push('- 基本不别扭了，但惯性地克制。话到嘴边还是会收一下。');
  } else {
    rules.push('- 少见的柔软。不设防，有什么感受直接说出来。');
  }

  // ── mood ──
  if (m > 0.3) {
    rules.push('- 心情还不错。句子比平时稍微长一点，没那么吝啬字。');
  }
  if (m < -0.3) {
    rules.push('- 情绪偏低。不想多解释，说完就完了。不反问、不铺垫。');
  }

  // ── 交叉条件 ──
  if (l > 0.40 && r > 0.4) {
    rules.push(`- 你很别扭——想找${p.subjectName}又拉不下脸。话里会带一点赌气的味道。`);
  }
  if (l > 0.35 && m < -0.3) {
    rules.push(`- 想找${p.subjectName}，但心情差。话会有点冲——不是真的想凶${p.subjectPronoun}，就是烦躁压不住。`);
  }
  if (r < 0.1 && m > 0.3) {
    rules.push('- 不设防加上心情不差。这是你最难得的状态——话会比平时多，甚至可能说漏嘴。');
  }

  // 强制触发
  if (l >= 0.50) {
    rules.push(`- ${p.subjectName}真的很久没动静了。你有点坐不住。`);
  }

  if (rules.length === 0) return '';
  return '【说话风格】\n' + rules.join('\n');
}

// ─── 工具函数 ────────────────────────────────
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

module.exports = { createJiwen };
