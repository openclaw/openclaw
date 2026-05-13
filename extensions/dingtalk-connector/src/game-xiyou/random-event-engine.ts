/**
 * 随机事件系统 (v2)
 *
 * 低概率触发的特殊剧情事件，打破日常节奏，制造惊喜和紧张感。
 * 事件分为三类：增益(8%)、挑战(5%)、灾厄(3%)。
 * 独立于掉落和机缘触发，同一事件 24 小时内不重复。
 */

import { randomBytes } from 'crypto';
import type {
  RandomEvent, ChallengeEvent, EventCategory, EventEffect, EventDuration,
  EventResolution, ActiveEventState, EventHistoryEntry, EventStats,
  ChallengeCondition, ChallengeProgress, EventReward, EventPenalty,
  UserProfile, MonsterQuality,
} from './types.ts';

function cryptoRandom(): number {
  const buffer = randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
}

// ============ 事件数据定义 ============

const BLESSING_EVENTS: RandomEvent[] = [
  {
    id: 'EV001', name: '蟠桃大会', category: 'blessing', triggerRate: 0.015,
    description: '接下来 10 次操作修行值 ×3',
    flavorText: '王母娘娘设宴，蟠桃大会开席！修行值大涨！',
    effect: { type: 'exp_multiplier', value: 3, targetCount: 10 },
    duration: { type: 'operation_count', total: 10, remaining: 10 },
  },
  {
    id: 'EV002', name: '月光宝盒', category: 'blessing', triggerRate: 0.010,
    description: '下一次掉落品质强制提升一级',
    flavorText: '紫霞仙子留下的月光宝盒，时光倒流，命运改写！',
    effect: { type: 'quality_boost', value: 1 },
    duration: { type: 'drop_count', total: 1, remaining: 1 },
  },
  {
    id: 'EV003', name: '龙宫寻宝', category: 'blessing', triggerRate: 0.015,
    description: '立即额外触发一次掉落',
    flavorText: '东海龙宫大门洞开，宝物任你挑选！',
    effect: { type: 'extra_drop', value: 1 },
    duration: { type: 'instant', total: 1, remaining: 0 },
  },
  {
    id: 'EV004', name: '仙人指路', category: 'blessing', triggerRate: 0.020,
    description: '下 5 次操作的产品关联权重 ×5',
    flavorText: '南极仙翁路过，指了指前方："那边有好东西。"',
    effect: { type: 'product_weight', value: 5, targetCount: 5 },
    duration: { type: 'operation_count', total: 5, remaining: 5 },
  },
  {
    id: 'EV005', name: '蟠桃熟了', category: 'blessing', triggerRate: 0.010,
    description: '立即获得 30-100 随机修行值',
    flavorText: '三千年一熟的蟠桃，今日恰好落入你手。',
    effect: { type: 'exp_flat', value: 0 }, // value 在触发时随机
    duration: { type: 'instant', total: 1, remaining: 0 },
  },
  {
    id: 'EV006', name: '土地公的宝箱', category: 'blessing', triggerRate: 0.010,
    description: '随机获得一件一次性法宝',
    flavorText: '土地公从地下冒出来："大圣，这个给你！"',
    effect: { type: 'treasure_grant', value: 1 },
    duration: { type: 'instant', total: 1, remaining: 0 },
  },
];

const CHALLENGE_EVENTS_DATA: Array<Omit<ChallengeEvent, 'progress'>> = [
  {
    id: 'EV101', name: '妖王入侵', category: 'challenge', triggerRate: 0.015,
    description: '接下来连续成功 5 次',
    flavorText: '一股强大的妖气从远方袭来——"哈哈哈，齐天大圣不过如此！"',
    effect: { type: 'exp_flat', value: 0 },
    duration: { type: 'operation_count', total: 8, remaining: 8 },
    challengeCondition: { type: 'consecutive_success', target: 5, current: 0 },
    successReward: { exp: 80, pityBonus: 5 },
    failurePenalty: { expLoss: 30 },
    operationLimit: 8,
  },
  {
    id: 'EV102', name: '火焰山', category: 'challenge', triggerRate: 0.010,
    description: '接下来 10 次操作中使用 ≥3 种不同产品',
    flavorText: '火焰山烈焰滔天，唯有多方尝试方能通过！',
    effect: { type: 'exp_flat', value: 0 },
    duration: { type: 'operation_count', total: 10, remaining: 10 },
    challengeCondition: { type: 'product_variety', target: 3, current: 0 },
    successReward: { exp: 60, escapeRateMod: -0.05 },
    failurePenalty: { expLoss: 0, comboReset: true },
    operationLimit: 10,
  },
  {
    id: 'EV103', name: '通天河阻路', category: 'challenge', triggerRate: 0.010,
    description: '接下来连续成功 3 次且收服 ≥1 只妖怪',
    flavorText: '通天河水势汹涌，需要勇气和实力才能渡过！',
    effect: { type: 'exp_flat', value: 0 },
    duration: { type: 'operation_count', total: 5, remaining: 5 },
    challengeCondition: { type: 'consecutive_success', target: 3, current: 0 },
    successReward: { exp: 100, extraDrop: true },
    failurePenalty: { expLoss: 20 },
    operationLimit: 5,
  },
  {
    id: 'EV104', name: '真假美猴王', category: 'challenge', triggerRate: 0.005,
    description: '接下来 3 次掉落中选出"真"的那只',
    flavorText: '六耳猕猴现身，真假难辨！',
    effect: { type: 'exp_flat', value: 0 },
    duration: { type: 'drop_count', total: 3, remaining: 3 },
    challengeCondition: { type: 'pick_correct', target: 1, current: 0 },
    successReward: { exp: 100 },
    failurePenalty: { expLoss: 0 },
    operationLimit: 3,
  },
  {
    id: 'EV105', name: '盘丝洞迷阵', category: 'challenge', triggerRate: 0.005,
    description: '接下来 5 次操作必须使用 5 种不同产品',
    flavorText: '蜘蛛精的丝网密布，每一步都不能重复！',
    effect: { type: 'exp_flat', value: 0 },
    duration: { type: 'operation_count', total: 5, remaining: 5 },
    challengeCondition: { type: 'product_variety', target: 5, current: 0 },
    successReward: { exp: 120, monster: { qualityMin: 'rare' } },
    failurePenalty: { expLoss: 50 },
    operationLimit: 5,
  },
  {
    id: 'EV106', name: '比丘国救童', category: 'challenge', triggerRate: 0.005,
    description: '接下来 8 次操作中成功率 ≥80%',
    flavorText: '比丘国的孩子们需要你的帮助！',
    effect: { type: 'exp_flat', value: 0 },
    duration: { type: 'operation_count', total: 8, remaining: 8 },
    challengeCondition: { type: 'success_rate', target: 7, current: 0 },
    successReward: { exp: 150, treasureFragment: 'random' },
    failurePenalty: { expLoss: 40 },
    operationLimit: 8,
  },
];

const DISASTER_EVENTS: RandomEvent[] = [
  {
    id: 'EV201', name: '黑风来袭', category: 'disaster', triggerRate: 0.010,
    description: '接下来 5 次掉落逃跑率 +20%',
    flavorText: '黑风山的妖气蔓延而来——"嘿嘿嘿，让你的妖怪都跑光！"',
    effect: { type: 'escape_rate_mod', value: 0.20 },
    duration: { type: 'drop_count', total: 5, remaining: 5 },
    resolution: { type: 'consecutive_success', count: 3, description: '连续成功 3 次可提前解除' },
  },
  {
    id: 'EV202', name: '金蝉脱壳', category: 'disaster', triggerRate: 0.005,
    description: '随机一只已收服的精良妖怪逃跑',
    flavorText: '一阵妖风吹过，你的妖怪图鉴闪了一下……',
    effect: { type: 'monster_escape', value: 1 },
    duration: { type: 'instant', total: 1, remaining: 0 },
  },
  {
    id: 'EV203', name: '妖雾弥漫', category: 'disaster', triggerRate: 0.008,
    description: '接下来 3 次掉落品质上限降为精良',
    flavorText: '浓雾笼罩，视线模糊，只能看到近处的小妖……',
    effect: { type: 'quality_cap', value: 1 }, // 1 = fine
    duration: { type: 'drop_count', total: 3, remaining: 3 },
    resolution: { type: 'use_treasure', treasureId: 'zhaoyaojing', description: '使用法宝"照妖镜"可立即解除' },
  },
  {
    id: 'EV204', name: '紧箍咒发作', category: 'disaster', triggerRate: 0.004,
    description: '接下来 5 次操作修行值减半',
    flavorText: '头痛欲裂！唐僧又念紧箍咒了！',
    effect: { type: 'exp_halve', value: 0.5 },
    duration: { type: 'operation_count', total: 5, remaining: 5 },
    resolution: { type: 'complete_bounty', description: '完成 1 张悬赏令可提前解除' },
  },
  {
    id: 'EV205', name: '五行山镇压', category: 'disaster', triggerRate: 0.002,
    description: '连击归零 + 接下来 3 次操作无掉落',
    flavorText: '五行山从天而降，压得你动弹不得！',
    effect: { type: 'no_drop', value: 3 },
    duration: { type: 'operation_count', total: 3, remaining: 3 },
    resolution: { type: 'trigger_encounter', description: '触发 1 次神仙机缘可提前解除' },
  },
  {
    id: 'EV206', name: '走火入魔', category: 'disaster', triggerRate: 0.001,
    description: '修行值 -100 + 保底计数器全部 -10',
    flavorText: '修炼走火入魔，功力大损！',
    effect: { type: 'exp_loss', value: 100 },
    duration: { type: 'instant', total: 1, remaining: 0 },
  },
];

// ============ 核心逻辑 ============

/**
 * 创建默认的活跃事件状态
 */
export function createDefaultActiveEventState(): ActiveEventState {
  return {
    currentEvents: [],
    activeChallenge: null,
    lastEventTriggerTime: {},
  };
}

/**
 * 创建默认的事件统计
 */
export function createDefaultEventStats(): EventStats {
  return {
    totalTriggered: 0,
    challengesCompleted: 0,
    challengesFailed: 0,
    disastersResolved: 0,
  };
}

/**
 * 检查并触发随机事件
 *
 * @returns 触发的事件，或 null
 */
export function checkRandomEvent(profile: UserProfile): RandomEvent | ChallengeEvent | null {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  // 收集所有候选事件
  const candidates: Array<RandomEvent | Omit<ChallengeEvent, 'progress'>> = [
    ...BLESSING_EVENTS,
    ...CHALLENGE_EVENTS_DATA,
    ...DISASTER_EVENTS,
  ];

  for (const candidate of candidates) {
    // 24 小时内不重复
    const lastTrigger = profile.activeEvents.lastEventTriggerTime[candidate.id] ?? 0;
    if (now - lastTrigger < oneDayMs) continue;

    // 挑战事件：同时最多 1 个进行中
    if (candidate.category === 'challenge' && profile.activeEvents.activeChallenge) continue;

    // 概率判定
    if (cryptoRandom() < candidate.triggerRate) {
      profile.activeEvents.lastEventTriggerTime[candidate.id] = now;
      profile.eventStats.totalTriggered += 1;

      // 实例化事件
      const event = instantiateEvent(candidate, profile);

      // 添加到活跃事件
      if (event.category === 'challenge') {
        profile.activeEvents.activeChallenge = event as ChallengeEvent;
      } else if (event.duration.type !== 'instant') {
        profile.activeEvents.currentEvents.push(event);
      }

      // 记录历史
      profile.eventHistory.push({
        eventId: event.id,
        triggeredAt: now,
      });

      return event;
    }
  }

  return null;
}

/** 一次性法宝 ID 池（用于 EV006 土地公的宝箱） */
const CONSUMABLE_TREASURE_IDS = ['pantao', 'renshenguo'];

/**
 * 实例化事件（处理随机值、即时效果等）
 *
 * 即时事件的效果在此函数中直接应用到 profile。
 * 持续性事件仅初始化状态，效果由 tickActiveEvents / 查询函数处理。
 */
function instantiateEvent(
  template: RandomEvent | Omit<ChallengeEvent, 'progress'>,
  profile: UserProfile
): RandomEvent | ChallengeEvent {
  const event: RandomEvent | ChallengeEvent = JSON.parse(JSON.stringify(template));

  switch (event.id) {
    // ---- 增益即时事件 ----

    case 'EV005': {
      // 蟠桃熟了：随机 30-100 修行值，立即发放
      const expGain = Math.floor(30 + cryptoRandom() * 71);
      event.effect.value = expGain;
      profile.totalExp += expGain;
      break;
    }

    case 'EV006': {
      // 土地公的宝箱：随机赐予一件一次性法宝
      const treasureId = CONSUMABLE_TREASURE_IDS[
        Math.floor(cryptoRandom() * CONSUMABLE_TREASURE_IDS.length)
      ];
      event.effect.value = 1;
      // 添加法宝到背包（如果已有则跳过，不重复添加）
      if (!profile.treasures.includes(treasureId)) {
        profile.treasures.push(treasureId);
      }
      // 将赐予的法宝 ID 记录在 description 中供渲染使用
      event.description = `获得了一次性法宝：${treasureId === 'pantao' ? '蟠桃' : '人参果'}`;
      break;
    }

    // EV003 龙宫寻宝：额外掉落标记，由主引擎 (index.ts) 在 checkRandomEvent 返回后检查
    // event.effect.type === 'extra_drop' 时触发额外一次 executeDrop

    // ---- 灾厄即时事件 ----

    case 'EV202': {
      // 金蝉脱壳：随机移除一只已收服的精良妖怪
      // 实际的图鉴移除由主引擎处理（需要访问 collection），
      // 这里标记 effect.value 为需要移除的品质等级（1 = fine）
      event.effect.value = 1;
      break;
    }

    case 'EV205': {
      // 五行山镇压：连击归零 + 3 次无掉落
      profile.currentCombo = 0;
      break;
    }

    case 'EV206': {
      // 走火入魔：修行值 -100 + 保底计数器全部 -10
      profile.totalExp = Math.max(0, profile.totalExp - 100);
      profile.pityCounters.sinceLastRare = Math.max(0, profile.pityCounters.sinceLastRare - 10);
      profile.pityCounters.sinceLastEpic = Math.max(0, profile.pityCounters.sinceLastEpic - 10);
      profile.pityCounters.sinceLastLegendary = Math.max(0, profile.pityCounters.sinceLastLegendary - 10);
      profile.pityCounters.totalDropsWithoutShiny = Math.max(0, profile.pityCounters.totalDropsWithoutShiny - 10);
      break;
    }
  }

  // 挑战事件：初始化 progress 和 usedProducts 追踪
  if (event.category === 'challenge') {
    const challengeEvent = event as ChallengeEvent;
    challengeEvent.progress = {
      operationsUsed: 0,
      operationLimit: challengeEvent.operationLimit,
      conditionMet: false,
      usedProducts: [],
    };
  }

  return event;
}

/**
 * 每次操作后更新活跃事件的持续时间和状态
 *
 * @returns 本次过期/完成的事件列表
 */
export function tickActiveEvents(
  profile: UserProfile,
  operationSuccess: boolean,
  product: string,
  capturedMonster: boolean
): ExpiredEventResult[] {
  const results: ExpiredEventResult[] = [];

  // 更新持续性事件
  const remainingEvents: RandomEvent[] = [];
  for (const event of profile.activeEvents.currentEvents) {
    if (event.duration.type === 'operation_count') {
      event.duration.remaining -= 1;
    }
    // drop_count 类型在掉落时递减（由 drop-engine 调用 tickDropEvent）

    // 检查灾厄事件的化解条件
    if (event.category === 'disaster' && event.resolution) {
      if (checkResolution(event.resolution, profile, operationSuccess)) {
        results.push({ event, outcome: 'resolved' });
        profile.eventStats.disastersResolved += 1;
        updateEventHistory(profile, event.id, 'resolved');
        continue;
      }
    }

    if (event.duration.remaining <= 0) {
      results.push({ event, outcome: 'expired' });
      updateEventHistory(profile, event.id, 'expired');
    } else {
      remainingEvents.push(event);
    }
  }
  profile.activeEvents.currentEvents = remainingEvents;

  // 更新挑战事件
  const challenge = profile.activeEvents.activeChallenge;
  if (challenge) {
    challenge.progress.operationsUsed += 1;
    challenge.duration.remaining -= 1;

    // 更新挑战条件进度
    updateChallengeProgress(challenge, operationSuccess, product, capturedMonster);

    // 检查挑战是否完成
    if (challenge.progress.conditionMet) {
      results.push({ event: challenge, outcome: 'success' });
      applyChallengeReward(profile, challenge);
      profile.eventStats.challengesCompleted += 1;
      updateEventHistory(profile, challenge.id, 'success');
      profile.activeEvents.activeChallenge = null;
    } else if (challenge.progress.operationsUsed >= challenge.progress.operationLimit) {
      results.push({ event: challenge, outcome: 'failure' });
      applyChallengePenalty(profile, challenge);
      profile.eventStats.challengesFailed += 1;
      updateEventHistory(profile, challenge.id, 'failure');
      profile.activeEvents.activeChallenge = null;
    }
  }

  return results;
}

export interface ExpiredEventResult {
  event: RandomEvent | ChallengeEvent;
  outcome: 'expired' | 'resolved' | 'success' | 'failure';
}

/**
 * 掉落时递减 drop_count 类型事件的剩余次数
 */
export function tickDropEvents(profile: UserProfile): void {
  for (const event of profile.activeEvents.currentEvents) {
    if (event.duration.type === 'drop_count') {
      event.duration.remaining -= 1;
    }
  }
}

// ============ 事件效果查询 ============

/**
 * 获取当前活跃的修行值倍率修正
 */
export function getActiveExpMultiplier(profile: UserProfile): number {
  let multiplier = 1;
  for (const event of profile.activeEvents.currentEvents) {
    if (event.effect.type === 'exp_multiplier') {
      multiplier *= event.effect.value;
    }
    if (event.effect.type === 'exp_halve') {
      multiplier *= event.effect.value;
    }
  }
  return multiplier;
}

/**
 * 检查是否有品质提升事件
 */
export function getQualityBoost(profile: UserProfile): number {
  for (const event of profile.activeEvents.currentEvents) {
    if (event.effect.type === 'quality_boost' && event.duration.remaining > 0) {
      return event.effect.value;
    }
  }
  return 0;
}

/**
 * 检查是否有品质上限事件
 */
export function getQualityCap(profile: UserProfile): MonsterQuality | null {
  for (const event of profile.activeEvents.currentEvents) {
    if (event.effect.type === 'quality_cap' && event.duration.remaining > 0) {
      return 'fine'; // quality_cap value=1 表示上限为 fine
    }
  }
  return null;
}

/**
 * 检查是否有禁止掉落事件
 */
export function isDropSuppressed(profile: UserProfile): boolean {
  return profile.activeEvents.currentEvents.some(
    e => e.effect.type === 'no_drop' && e.duration.remaining > 0
  );
}

/**
 * 获取产品关联权重倍率修正
 */
export function getProductWeightBoost(profile: UserProfile): number {
  for (const event of profile.activeEvents.currentEvents) {
    if (event.effect.type === 'product_weight' && event.duration.remaining > 0) {
      return event.effect.value;
    }
  }
  return 1;
}

// ============ 内部辅助 ============

function checkResolution(
  resolution: EventResolution,
  profile: UserProfile,
  operationSuccess: boolean
): boolean {
  switch (resolution.type) {
    case 'consecutive_success':
      return profile.currentCombo >= (resolution.count ?? 3);

    case 'use_treasure':
      // 由 commands.ts 在使用法宝时检查并调用 resolveDisasterEvent
      return false;

    case 'complete_bounty':
      // 由 bounty-system 在完成悬赏时检查
      return false;

    case 'trigger_encounter':
      // 由 encounter-system 在触发机缘时检查
      return false;

    default:
      return false;
  }
}

/**
 * 手动解除灾厄事件（由外部系统调用）
 */
export function resolveDisasterEvent(
  profile: UserProfile,
  resolutionType: EventResolution['type']
): RandomEvent | null {
  const index = profile.activeEvents.currentEvents.findIndex(
    e => e.category === 'disaster' && e.resolution?.type === resolutionType
  );

  if (index === -1) return null;

  const event = profile.activeEvents.currentEvents[index];
  profile.activeEvents.currentEvents.splice(index, 1);
  profile.eventStats.disastersResolved += 1;
  updateEventHistory(profile, event.id, 'resolved');
  return event;
}

function updateChallengeProgress(
  challenge: ChallengeEvent,
  operationSuccess: boolean,
  product: string,
  capturedMonster: boolean
): void {
  const usedProducts = challenge.progress.usedProducts ?? [];

  switch (challenge.challengeCondition.type) {
    case 'consecutive_success':
      if (operationSuccess) {
        challenge.challengeCondition.current += 1;
      } else {
        challenge.challengeCondition.current = 0;
      }
      break;

    case 'product_variety':
      if (!usedProducts.includes(product)) {
        usedProducts.push(product);
        challenge.progress.usedProducts = usedProducts;
      }
      challenge.challengeCondition.current = usedProducts.length;
      break;

    case 'success_rate':
      if (operationSuccess) {
        challenge.challengeCondition.current += 1;
      }
      break;

    case 'capture_count':
      if (capturedMonster) {
        challenge.challengeCondition.current += 1;
      }
      break;

    case 'pick_correct':
      // "真假美猴王"：每次掉落随机判定是否选中"真"的（1/3 概率）
      if (cryptoRandom() < 1 / 3) {
        challenge.challengeCondition.current += 1;
      }
      break;
  }

  if (challenge.challengeCondition.current >= challenge.challengeCondition.target) {
    challenge.progress.conditionMet = true;
  }
}

function applyChallengeReward(profile: UserProfile, challenge: ChallengeEvent): void {
  const reward = challenge.successReward;
  profile.totalExp += reward.exp;

  if (reward.pityBonus) {
    profile.pityCounters.sinceLastRare += reward.pityBonus;
    profile.pityCounters.sinceLastEpic += reward.pityBonus;
    profile.pityCounters.sinceLastLegendary += reward.pityBonus;
  }
}

function applyChallengePenalty(profile: UserProfile, challenge: ChallengeEvent): void {
  const penalty = challenge.failurePenalty;
  profile.totalExp = Math.max(0, profile.totalExp - penalty.expLoss);

  if (penalty.comboReset) {
    profile.currentCombo = 0;
  }

  if (penalty.pityLoss) {
    profile.pityCounters.sinceLastRare = Math.max(0, profile.pityCounters.sinceLastRare - penalty.pityLoss);
    profile.pityCounters.sinceLastEpic = Math.max(0, profile.pityCounters.sinceLastEpic - penalty.pityLoss);
    profile.pityCounters.sinceLastLegendary = Math.max(0, profile.pityCounters.sinceLastLegendary - penalty.pityLoss);
  }
}

function updateEventHistory(
  profile: UserProfile,
  eventId: string,
  outcome: EventHistoryEntry['outcome']
): void {
  const entry = profile.eventHistory.find(
    e => e.eventId === eventId && !e.outcome
  );
  if (entry) {
    entry.outcome = outcome;
  }
}

/**
 * 获取所有事件定义（用于成就判定等）
 */
export function getAllEventDefinitions(): RandomEvent[] {
  return [
    ...BLESSING_EVENTS,
    ...DISASTER_EVENTS,
  ];
}

/**
 * 获取所有挑战事件定义
 */
export function getAllChallengeDefinitions(): Array<Omit<ChallengeEvent, 'progress'>> {
  return CHALLENGE_EVENTS_DATA;
}
