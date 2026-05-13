/**
 * 西游妖魔榜养成系统 - 类型定义
 *
 * 核心概念：每次通过 agent 成功调用 dws CLI，就是一次"降妖除魔"。
 * 妖怪按品质随机掉落，神仙按机缘随机现身，所有数据与用户 UID 强绑定。
 */

// ============ 品质与分级 ============

export type MonsterQuality = 'normal' | 'fine' | 'rare' | 'epic' | 'legendary' | 'shiny';

export const QUALITY_LABELS: Record<MonsterQuality, string> = {
  normal: '⬜ 普通',
  fine: '🟢 精良',
  rare: '🔵 稀有',
  epic: '🟣 史诗',
  legendary: '🟡 传说',
  shiny: '✨ 闪光',
};

export const QUALITY_ORDER: MonsterQuality[] = [
  'normal', 'fine', 'rare', 'epic', 'legendary', 'shiny',
];

// ============ 妖怪 ============

export interface Monster {
  id: string;
  name: string;
  quality: MonsterQuality;
  origin: string;
  relatedProduct: string | null;
  captureQuote: string;
}

export interface CapturedMonster {
  monsterId: string;
  capturedAt: number;
  isShiny: boolean;
  commandHash: string;
  comboCount: number;
}

// ============ 神仙 ============

export type EncounterType = 'guidance' | 'treasure' | 'apprentice';

export interface Immortal {
  id: string;
  name: string;
  guidanceQuote: string;
  treasureId: string;
  apprenticeBuff: Buff;
}

export interface Encounter {
  immortalId: string;
  type: EncounterType;
  treasureId?: string;
  buffId?: string;
  occurredAt: number;
}

// ============ 法宝 ============

export type BuffEffect =
  | 'comboBonus'
  | 'expMultiplier'
  | 'pityReduction'
  | 'epicRateBonus'
  | 'rareRateBonus'
  | 'legendaryRateBonus'
  | 'shinyRateBonus'
  | 'allRateBonus'
  | 'signInMultiplier'
  | 'comboLimitBonus'
  | 'normalUpgrade'
  | 'instantExp'
  | 'extraDrop'
  | 'pitySpeed'
  | 'previewNextQuality'
  | 'cliRetry';

export interface Buff {
  id: string;
  source: 'treasure' | 'apprentice' | 'achievement';
  effect: BuffEffect;
  value: number;
}

export interface Treasure {
  id: string;
  name: string;
  source: string;
  description: string;
  effect: BuffEffect;
  value: number;
  consumable: boolean;
}

// ============ 成就 ============

export type AchievementCategory = 'cultivation' | 'collection' | 'product' | 'hidden';

export interface Achievement {
  id: string;
  name: string;
  emoji: string;
  description: string;
  category: AchievementCategory;
  condition: AchievementCondition;
  expReward: number;
  titleReward?: string;
}

export type AchievementCondition =
  | { type: 'totalOperations'; count: number }
  | { type: 'consecutiveSignIn'; days: number }
  | { type: 'maxCombo'; count: number }
  | { type: 'totalRecoveries'; count: number }
  | { type: 'uniqueMonsters'; count: number }
  | { type: 'shinyMonsters'; count: number }
  | { type: 'productUsage'; product: string; count: number }
  | { type: 'allProducts' }
  | { type: 'dailyOperations'; count: number }
  | { type: 'nightOwl' }
  | { type: 'pityTriggered' }
  | { type: 'consecutiveFailThenSuccess'; failCount: number }
  | { type: 'dailyRareOrAbove'; count: number }
  | { type: 'birthday' }
  | { type: 'consecutiveReport'; days: number }
  // v2: 逃跑相关
  | { type: 'totalEscapes'; count: number }
  | { type: 'consecutiveNoEscape'; count: number }
  // v2: 悬赏令相关
  | { type: 'totalBountiesCompleted'; count: number }
  | { type: 'goldBountiesCompleted'; count: number }
  | { type: 'consecutiveFullClear'; days: number }
  // v2: 随机事件相关
  | { type: 'totalEventsTriggered'; count: number }
  | { type: 'challengesCompleted'; count: number }
  | { type: 'survivedMadness' }
  | { type: 'specificEventCount'; eventId: string; count: number }
  | { type: 'specificChallengeSuccess'; eventId: string }
  | { type: 'disasterThenBlessing' }
  | { type: 'disastersResolved'; count: number };

// ============ 等级 ============

export interface LevelDefinition {
  level: number;
  title: string;
  requiredExp: number;
  unlockDescription?: string;
}

export const LEVEL_DEFINITIONS: LevelDefinition[] = [
  { level: 1, title: '凡人', requiredExp: 0, unlockDescription: '基础掉落池' },
  { level: 2, title: '樵夫', requiredExp: 120 },
  { level: 3, title: '修行者', requiredExp: 320, unlockDescription: '解锁"机缘"系统（神仙随机现身）' },
  { level: 4, title: '散仙', requiredExp: 800, unlockDescription: '掉落池扩展：加入稀有妖怪' },
  { level: 5, title: '天兵', requiredExp: 2000, unlockDescription: '解锁"法宝"系统' },
  { level: 6, title: '天将', requiredExp: 4000, unlockDescription: '掉落池扩展：加入史诗妖怪' },
  { level: 7, title: '哪吒', requiredExp: 8000, unlockDescription: '连击加成上限提升至 ×4.0' },
  { level: 8, title: '二郎神', requiredExp: 16000, unlockDescription: '掉落池扩展：加入传说妖怪' },
  { level: 9, title: '齐天大圣', requiredExp: 32000, unlockDescription: '解锁"闪光"掉落' },
  { level: 10, title: '斗战胜佛', requiredExp: 60000, unlockDescription: '全图鉴解锁提示、专属称号色' },
];

// ============ 产品修行值 ============

export const PRODUCT_BASE_EXP: Record<string, number> = {
  aitable: 3,
  calendar: 2,
  chat: 2,
  contact: 1,
  todo: 2,
  approval: 4,
  attendance: 2,
  report: 3,
  ding: 1,
  workbench: 3,
  devdoc: 1,
};

// ============ 保底计数器 ============

export interface PityCounters {
  sinceLastRare: number;
  sinceLastEpic: number;
  sinceLastLegendary: number;
  totalDropsWithoutShiny: number;
}

/** v2: 保底阈值上调 */
export const PITY_THRESHOLDS = {
  rare: 30,
  epic: 80,
  legendary: 150,
  shiny: 800,
} as const;

/** v2: 软保底起始点 — 接近硬保底时概率逐步提升 */
export const SOFT_PITY_START = {
  rare: 20,
  epic: 60,
  legendary: 120,
  shiny: 600,
} as const;

/** v2: 软保底每次额外增加的概率 */
export const SOFT_PITY_RATE_PER_STEP = {
  rare: 0.03,
  epic: 0.02,
  legendary: 0.01,
  shiny: 0.0005,
} as const;

// ============ 逃跑机制 (v2) ============

/** 各品质的基础逃跑率 */
export const BASE_ESCAPE_RATES: Record<MonsterQuality, number> = {
  normal: 0,
  fine: 0.10,
  rare: 0.25,
  epic: 0.40,
  legendary: 0.60,
  shiny: 0.75,
};

/** 逃跑率的最低下限 */
export const MIN_ESCAPE_RATE = 0.05;

export interface EscapeModifier {
  source: string;
  value: number;
  description: string;
}

// ============ 悬赏令 (v2) ============

export type BountyTier = 'bronze' | 'silver' | 'gold';

export type BountyConditionType =
  | 'capture'
  | 'combo'
  | 'command'
  | 'encounter'
  | 'product_variety'
  | 'quality_variety';

export interface BountyCondition {
  type: BountyConditionType;
  qualityMin?: MonsterQuality;
  product?: string;
  count: number;
  isUpMonster?: boolean;
  isNew?: boolean;
}

export interface BountyReward {
  exp: number;
  treasureFragment?: string;
  buff?: TemporaryBuff;
}

export interface TemporaryBuff {
  effect: BuffEffect;
  value: number;
  description: string;
  durationOperations?: number;
}

export interface Bounty {
  id: string;
  tier: BountyTier;
  description: string;
  target: number;
  current: number;
  completed: boolean;
  reward: BountyReward;
  condition: BountyCondition;
}

export interface DailyBountyState {
  date: string;
  bounties: Bounty[];
  completedCount: number;
}

export interface BountyHistory {
  totalCompleted: number;
  bronzeCompleted: number;
  silverCompleted: number;
  goldCompleted: number;
  consecutiveFullClear: number;
}

// ============ 随机事件 (v2) ============

export type EventCategory = 'blessing' | 'challenge' | 'disaster';

export type EventEffectType =
  | 'exp_multiplier'
  | 'quality_boost'
  | 'extra_drop'
  | 'product_weight'
  | 'escape_rate_mod'
  | 'exp_flat'
  | 'treasure_grant'
  | 'monster_escape'
  | 'quality_cap'
  | 'exp_halve'
  | 'combo_reset'
  | 'no_drop'
  | 'exp_loss'
  | 'pity_loss';

export interface EventEffect {
  type: EventEffectType;
  value: number;
  targetCount?: number;
}

export interface EventDuration {
  type: 'instant' | 'operation_count' | 'drop_count';
  total: number;
  remaining: number;
}

export interface EventResolution {
  type: 'consecutive_success' | 'use_treasure' | 'complete_bounty' | 'trigger_encounter';
  count?: number;
  treasureId?: string;
  description: string;
}

export interface RandomEvent {
  id: string;
  name: string;
  category: EventCategory;
  triggerRate: number;
  description: string;
  flavorText: string;
  effect: EventEffect;
  duration: EventDuration;
  resolution?: EventResolution;
}

export type ChallengeConditionType =
  | 'consecutive_success'
  | 'product_variety'
  | 'capture_count'
  | 'success_rate'
  | 'pick_correct';

export interface ChallengeCondition {
  type: ChallengeConditionType;
  target: number;
  current: number;
}

export interface ChallengeProgress {
  operationsUsed: number;
  operationLimit: number;
  conditionMet: boolean;
  /** 挑战期间使用过的不同产品（用于 product_variety 条件） */
  usedProducts?: string[];
}

export interface EventReward {
  exp: number;
  pityBonus?: number;
  escapeRateMod?: number;
  extraDrop?: boolean;
  treasureFragment?: string;
  monster?: { qualityMin: MonsterQuality };
}

export interface EventPenalty {
  expLoss: number;
  comboReset?: boolean;
  pityLoss?: number;
}

export interface ChallengeEvent extends RandomEvent {
  category: 'challenge';
  challengeCondition: ChallengeCondition;
  successReward: EventReward;
  failurePenalty: EventPenalty;
  operationLimit: number;
  progress: ChallengeProgress;
}

export interface ActiveEventState {
  currentEvents: RandomEvent[];
  activeChallenge: ChallengeEvent | null;
  lastEventTriggerTime: Record<string, number>;
}

export interface EventHistoryEntry {
  eventId: string;
  triggeredAt: number;
  outcome?: 'success' | 'failure' | 'resolved' | 'expired';
}

export interface EventStats {
  totalTriggered: number;
  challengesCompleted: number;
  challengesFailed: number;
  disastersResolved: number;
}

// ============ 用户档案 ============

export interface GamificationSettings {
  enabled: boolean;
  showDropAnimation: boolean;
  muteNormalDrops: boolean;
}

export interface UserProfile {
  uidHash: string;
  level: number;
  title: string;
  totalExp: number;
  totalOperations: number;
  currentCombo: number;
  maxCombo: number;
  consecutiveSignInDays: number;
  lastSignInDate: string;
  totalRecoveries: number;
  consecutiveFailures: number;
  productUsage: Record<string, number>;
  pityCounters: PityCounters;
  buffs: Buff[];
  settings: GamificationSettings;
  encounters: Encounter[];
  unlockedAchievements: string[];
  treasures: string[];
  consumedTreasures: string[];
  createdAt: number;
  checksum: string;
  /** v2: 妖怪逃跑追踪 — monsterId → 连续逃跑次数 */
  escapeHistory: Record<string, number>;
  /** v2: 累计逃跑次数 */
  totalEscapes: number;
  /** v2: 每日悬赏令状态 */
  dailyBounty: DailyBountyState | null;
  /** v2: 悬赏令历史统计 */
  bountyHistory: BountyHistory;
  /** v2: 当前活跃的随机事件 */
  activeEvents: ActiveEventState;
  /** v2: 事件统计 */
  eventStats: EventStats;
  /** v2: 事件历史记录 */
  eventHistory: EventHistoryEntry[];
}

export interface CollectionEntry {
  monsterId: string;
  firstCapturedAt: number;
  captureCount: number;
  isShiny: boolean;
}

export interface UserCollection {
  uidHash: string;
  entries: CollectionEntry[];
}

export interface HistoryRecord {
  timestamp: number;
  product: string;
  commandHash: string;
  success: boolean;
  expGained: number;
  monsterId?: string;
  isShiny?: boolean;
  encounterId?: string;
  achievementIds?: string[];
  /** v2: 妖怪是否逃跑 */
  escaped?: boolean;
  /** v2: 触发的事件 ID */
  eventId?: string;
  /** v2: 完成的悬赏令 ID 列表 */
  completedBountyIds?: string[];
}

export interface UserHistory {
  uidHash: string;
  records: HistoryRecord[];
}

// ============ 掉落结果 ============

export interface DropResult {
  monster: Monster;
  isShiny: boolean;
  isNew: boolean;
  expGained: number;
  isPityTriggered: boolean;
  isUpMonster: boolean;
  /** v2: 是否逃跑 */
  escaped: boolean;
  /** v2: 实际逃跑率（含修正） */
  escapeRate: number;
  /** v2: 应用的修正因子列表 */
  escapeModifiers: EscapeModifier[];
}

export interface ExpResult {
  baseExp: number;
  comboMultiplier: number;
  firstUseMultiplier: number;
  signInBonus: number;
  consecutiveSignInBonus: number;
  buffMultiplier: number;
  totalExp: number;
}

export interface LevelUpResult {
  previousLevel: number;
  previousTitle: string;
  newLevel: number;
  newTitle: string;
  unlockDescription?: string;
}

// ============ 引擎输出 ============

export interface GamificationOutput {
  expResult: ExpResult;
  dropResult: DropResult;
  encounter: Encounter | null;
  newAchievements: Achievement[];
  levelUp: LevelUpResult | null;
  /** v2: 完成的悬赏令列表 */
  completedBounties: Bounty[];
  /** v2: 触发的随机事件 */
  triggeredEvent: RandomEvent | null;
}

// ============ 掉落概率配置 ============

export const DROP_RATES: Record<MonsterQuality, number> = {
  shiny: 0.001,
  legendary: 0.009,
  epic: 0.04,
  rare: 0.10,
  fine: 0.25,
  normal: 0.60,
};

/** 等级门槛：低于此等级的品质会降级 */
export const QUALITY_LEVEL_GATES: Partial<Record<MonsterQuality, number>> = {
  rare: 4,
  epic: 6,
  legendary: 8,
  shiny: 9,
};

/** 连击加成倍率 */
export const COMBO_MULTIPLIERS: Array<{ threshold: number; multiplier: number }> = [
  { threshold: 10, multiplier: 3.0 },
  { threshold: 5, multiplier: 2.0 },
  { threshold: 3, multiplier: 1.5 },
];

/** 机缘触发概率 */
export const ENCOUNTER_RATES: Record<EncounterType, number> = {
  guidance: 0.08,
  treasure: 0.03,
  apprentice: 0.005,
};

/** 产品关联权重倍数 */
export const PRODUCT_WEIGHT_MULTIPLIER = 3;

/** UP 池权重倍数 */
export const UP_WEIGHT_MULTIPLIER = 5;
