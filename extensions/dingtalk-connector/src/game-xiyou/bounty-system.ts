/**
 * 悬赏令系统 (v2)
 *
 * 每日刷新 3 张悬赏令（铜/银/金），为日常使用增加目标感和方向性。
 * 使用基于 UID + 日期的种子随机，确保同一用户同一天结果一致。
 */

import { createHash } from 'crypto';
import type {
  Bounty, BountyTier, BountyCondition, BountyReward,
  DailyBountyState, BountyHistory, UserProfile, MonsterQuality,
  DropResult,
} from './types.ts';

// ============ 悬赏令模板池 ============

interface BountyTemplate {
  id: string;
  tier: BountyTier;
  descriptionTemplate: string;
  reward: BountyReward;
  condition: BountyCondition;
  hasProductPlaceholder?: boolean;
}

const BRONZE_POOL: BountyTemplate[] = [
  { id: 'B001', tier: 'bronze', descriptionTemplate: '成功执行 3 次任意 dws 命令', reward: { exp: 15 }, condition: { type: 'command', count: 3 } },
  { id: 'B002', tier: 'bronze', descriptionTemplate: '使用 {product} 成功执行 1 次命令', reward: { exp: 10 }, condition: { type: 'command', count: 1 }, hasProductPlaceholder: true },
  { id: 'B003', tier: 'bronze', descriptionTemplate: '收服 1 只任意妖怪', reward: { exp: 10 }, condition: { type: 'capture', count: 1 } },
  { id: 'B004', tier: 'bronze', descriptionTemplate: '达成 3 连击', reward: { exp: 20 }, condition: { type: 'combo', count: 3 } },
  { id: 'B005', tier: 'bronze', descriptionTemplate: '使用 2 种不同产品的命令', reward: { exp: 15 }, condition: { type: 'product_variety', count: 2 } },
  { id: 'B006', tier: 'bronze', descriptionTemplate: '收服 1 只精良及以上妖怪', reward: { exp: 20 }, condition: { type: 'capture', qualityMin: 'fine', count: 1 } },
  { id: 'B007', tier: 'bronze', descriptionTemplate: '成功执行 5 次任意 dws 命令', reward: { exp: 25 }, condition: { type: 'command', count: 5 } },
  { id: 'B008', tier: 'bronze', descriptionTemplate: '收服 2 只任意妖怪（不含逃跑）', reward: { exp: 20 }, condition: { type: 'capture', count: 2 } },
];

const SILVER_POOL: BountyTemplate[] = [
  { id: 'B101', tier: 'silver', descriptionTemplate: '收服 1 只稀有及以上妖怪', reward: { exp: 50 }, condition: { type: 'capture', qualityMin: 'rare', count: 1 } },
  { id: 'B102', tier: 'silver', descriptionTemplate: '达成 5 连击', reward: { exp: 40 }, condition: { type: 'combo', count: 5 } },
  { id: 'B103', tier: 'silver', descriptionTemplate: '使用 3 种不同产品的命令', reward: { exp: 35 }, condition: { type: 'product_variety', count: 3 } },
  { id: 'B104', tier: 'silver', descriptionTemplate: '收服 1 只与 {product} 关联的妖怪', reward: { exp: 30 }, condition: { type: 'capture', count: 1 }, hasProductPlaceholder: true },
  { id: 'B105', tier: 'silver', descriptionTemplate: '成功执行 10 次任意 dws 命令', reward: { exp: 50 }, condition: { type: 'command', count: 10 } },
  { id: 'B106', tier: 'silver', descriptionTemplate: '收服 3 只不同品质的妖怪', reward: { exp: 45 }, condition: { type: 'quality_variety', count: 3 } },
  { id: 'B107', tier: 'silver', descriptionTemplate: '触发 1 次神仙机缘', reward: { exp: 40 }, condition: { type: 'encounter', count: 1 } },
  { id: 'B108', tier: 'silver', descriptionTemplate: '收服 1 只图鉴中未拥有的新妖怪', reward: { exp: 60 }, condition: { type: 'capture', count: 1, isNew: true } },
];

const GOLD_POOL: BountyTemplate[] = [
  { id: 'B201', tier: 'gold', descriptionTemplate: '收服 1 只史诗及以上妖怪', reward: { exp: 100, treasureFragment: 'random' }, condition: { type: 'capture', qualityMin: 'epic', count: 1 } },
  { id: 'B202', tier: 'gold', descriptionTemplate: '达成 10 连击', reward: { exp: 80 }, condition: { type: 'combo', count: 10 } },
  { id: 'B203', tier: 'gold', descriptionTemplate: '使用 5 种不同产品的命令', reward: { exp: 70 }, condition: { type: 'product_variety', count: 5 } },
  { id: 'B204', tier: 'gold', descriptionTemplate: '单日收服 5 只不同妖怪', reward: { exp: 100 }, condition: { type: 'capture', count: 5 } },
  { id: 'B205', tier: 'gold', descriptionTemplate: '收服本周 UP 妖怪', reward: { exp: 120 }, condition: { type: 'capture', count: 1, isUpMonster: true } },
  { id: 'B206', tier: 'gold', descriptionTemplate: '触发 1 次赐宝机缘', reward: { exp: 80 }, condition: { type: 'encounter', count: 1 } },
  { id: 'B207', tier: 'gold', descriptionTemplate: '连续成功 15 次不中断', reward: { exp: 100 }, condition: { type: 'combo', count: 15 } },
  { id: 'B208', tier: 'gold', descriptionTemplate: '收服 2 只稀有及以上妖怪', reward: { exp: 90 }, condition: { type: 'capture', qualityMin: 'rare', count: 2 } },
];

const AVAILABLE_PRODUCTS = [
  'aitable', 'calendar', 'chat', 'contact', 'todo',
  'approval', 'attendance', 'report', 'ding', 'workbench', 'devdoc',
];

// ============ 种子随机 ============

function hashString(input: string): number {
  const hash = createHash('sha256').update(input).digest();
  return hash.readUInt32BE(0);
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (state >>> 0) / 0xFFFFFFFF;
  };
}

function pickRandom<T>(pool: T[], rng: () => number): T {
  const index = Math.floor(rng() * pool.length);
  return pool[index];
}

function getDayKey(): string {
  const now = new Date();
  const offset = 8 * 60; // UTC+8
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

// ============ 核心逻辑 ============

/**
 * 生成每日悬赏令
 */
export function generateDailyBounties(profile: UserProfile): DailyBountyState {
  const today = getDayKey();

  // 如果今天已经生成过，直接返回
  if (profile.dailyBounty && profile.dailyBounty.date === today) {
    return profile.dailyBounty;
  }

  const seed = hashString(profile.uidHash + today + 'bounty-salt');
  const rng = seededRandom(seed);

  const bronzeTemplate = pickRandom(BRONZE_POOL, rng);
  const silverTemplate = pickRandom(SILVER_POOL, rng);
  const goldTemplate = pickRandom(GOLD_POOL, rng);

  const bounties = [bronzeTemplate, silverTemplate, goldTemplate].map(template =>
    instantiateTemplate(template, rng)
  );

  const state: DailyBountyState = {
    date: today,
    bounties,
    completedCount: 0,
  };

  profile.dailyBounty = state;
  return state;
}

/**
 * 将模板实例化为具体的悬赏令
 */
function instantiateTemplate(template: BountyTemplate, rng: () => number): Bounty {
  let description = template.descriptionTemplate;
  const condition = { ...template.condition };

  if (template.hasProductPlaceholder) {
    const product = pickRandom(AVAILABLE_PRODUCTS, rng);
    description = description.replace('{product}', product);
    condition.product = product;
  }

  return {
    id: template.id,
    tier: template.tier,
    description,
    target: condition.count,
    current: 0,
    completed: false,
    reward: { ...template.reward },
    condition,
  };
}

// ============ 品质比较 ============

const QUALITY_RANK: Record<MonsterQuality, number> = {
  normal: 0,
  fine: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
  shiny: 5,
};

function isQualityAtLeast(actual: MonsterQuality, minimum: MonsterQuality): boolean {
  return QUALITY_RANK[actual] >= QUALITY_RANK[minimum];
}

// ============ 进度追踪 ============

/**
 * 操作后更新悬赏令进度
 *
 * @returns 本次新完成的悬赏令列表
 */
export function updateBountyProgress(
  profile: UserProfile,
  context: BountyUpdateContext
): Bounty[] {
  const bountyState = profile.dailyBounty;
  if (!bountyState) return [];

  const today = getDayKey();
  if (bountyState.date !== today) return [];

  const newlyCompleted: Bounty[] = [];

  for (const bounty of bountyState.bounties) {
    if (bounty.completed) continue;

    const progressBefore = bounty.current;
    updateSingleBountyProgress(bounty, context);

    if (!bounty.completed && bounty.current >= bounty.target) {
      bounty.completed = true;
      bountyState.completedCount += 1;
      newlyCompleted.push(bounty);

      // 发放奖励
      profile.totalExp += bounty.reward.exp;

      // 更新悬赏历史
      profile.bountyHistory.totalCompleted += 1;
      switch (bounty.tier) {
        case 'bronze': profile.bountyHistory.bronzeCompleted += 1; break;
        case 'silver': profile.bountyHistory.silverCompleted += 1; break;
        case 'gold': profile.bountyHistory.goldCompleted += 1; break;
      }
    }
  }

  // 检查全部完成
  if (bountyState.completedCount === 3) {
    profile.bountyHistory.consecutiveFullClear += 1;
  }

  return newlyCompleted;
}

export interface BountyUpdateContext {
  commandSuccess: boolean;
  product: string;
  dropResult?: DropResult;
  encounterTriggered: boolean;
  encounterType?: string;
  currentCombo: number;
  /** 今日使用过的不同产品集合 */
  todayProducts: Set<string>;
  /** 今日收服的不同品质集合 */
  todayQualities: Set<MonsterQuality>;
}

function updateSingleBountyProgress(bounty: Bounty, ctx: BountyUpdateContext): void {
  const { condition } = bounty;

  switch (condition.type) {
    case 'command':
      if (ctx.commandSuccess) {
        if (condition.product) {
          if (ctx.product === condition.product) bounty.current += 1;
        } else {
          bounty.current += 1;
        }
      }
      break;

    case 'capture':
      if (ctx.dropResult && !ctx.dropResult.escaped) {
        let matches = true;

        if (condition.qualityMin) {
          matches = matches && isQualityAtLeast(ctx.dropResult.monster.quality, condition.qualityMin);
        }
        if (condition.isUpMonster) {
          matches = matches && ctx.dropResult.isUpMonster;
        }
        if (condition.isNew) {
          matches = matches && ctx.dropResult.isNew;
        }
        if (condition.product) {
          matches = matches && ctx.dropResult.monster.relatedProduct === condition.product;
        }

        if (matches) bounty.current += 1;
      }
      break;

    case 'combo':
      // 连击类悬赏：直接用当前连击数作为进度
      bounty.current = Math.min(ctx.currentCombo, bounty.target);
      break;

    case 'encounter':
      if (ctx.encounterTriggered) {
        // B206 金令要求赐宝机缘
        if (bounty.id === 'B206') {
          if (ctx.encounterType === 'treasure') bounty.current += 1;
        } else {
          bounty.current += 1;
        }
      }
      break;

    case 'product_variety':
      bounty.current = Math.min(ctx.todayProducts.size, bounty.target);
      break;

    case 'quality_variety':
      bounty.current = Math.min(ctx.todayQualities.size, bounty.target);
      break;
  }
}

/**
 * 初始化默认的悬赏历史
 */
export function createDefaultBountyHistory(): BountyHistory {
  return {
    totalCompleted: 0,
    bronzeCompleted: 0,
    silverCompleted: 0,
    goldCompleted: 0,
    consecutiveFullClear: 0,
  };
}

/**
 * 检查今日是否需要重置连续全清计数
 * （如果昨天没有全部完成，重置为 0）
 */
export function checkBountyDayReset(profile: UserProfile): void {
  const today = getDayKey();
  if (profile.dailyBounty && profile.dailyBounty.date !== today) {
    // 昨天没全清
    if (profile.dailyBounty.completedCount < 3) {
      profile.bountyHistory.consecutiveFullClear = 0;
    }
  }
}
