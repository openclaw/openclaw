/**
 * 保底计数器
 *
 * 借鉴 Gacha 游戏的保底设计，防止"非酋"体验过差。
 * v2: 保底阈值全面上调 + 软保底机制（接近硬保底时概率逐步提升）。
 * 保底计数器在对应品质或更高品质掉落后重置。
 */

import type { PityCounters, MonsterQuality } from './types.ts';
import {
  PITY_THRESHOLDS, QUALITY_ORDER,
  SOFT_PITY_START, SOFT_PITY_RATE_PER_STEP,
} from './types.ts';

/**
 * 检查是否触发硬保底，返回应强制掉落的品质（如果有）
 */
export function checkPityTrigger(counters: PityCounters): MonsterQuality | null {
  if (counters.totalDropsWithoutShiny >= PITY_THRESHOLDS.shiny) {
    return 'shiny';
  }
  if (counters.sinceLastLegendary >= PITY_THRESHOLDS.legendary) {
    return 'legendary';
  }
  if (counters.sinceLastEpic >= PITY_THRESHOLDS.epic) {
    return 'epic';
  }
  if (counters.sinceLastRare >= PITY_THRESHOLDS.rare) {
    return 'rare';
  }
  return null;
}

/**
 * v2: 计算软保底额外概率加成
 *
 * 在接近硬保底阈值时，对应品质的掉落概率逐步提升，
 * 避免"临门一脚"的漫长等待。
 *
 * @returns 各品质的额外概率加成 { rare: 0.06, epic: 0, ... }
 */
export function getSoftPityBonuses(counters: PityCounters): Partial<Record<MonsterQuality, number>> {
  const bonuses: Partial<Record<MonsterQuality, number>> = {};

  // 稀有软保底：第 20 次起，每次额外 +3%
  if (counters.sinceLastRare >= SOFT_PITY_START.rare) {
    const steps = counters.sinceLastRare - SOFT_PITY_START.rare;
    bonuses.rare = steps * SOFT_PITY_RATE_PER_STEP.rare;
  }

  // 史诗软保底：第 60 次起，每次额外 +2%
  if (counters.sinceLastEpic >= SOFT_PITY_START.epic) {
    const steps = counters.sinceLastEpic - SOFT_PITY_START.epic;
    bonuses.epic = steps * SOFT_PITY_RATE_PER_STEP.epic;
  }

  // 传说软保底：第 120 次起，每次额外 +1%
  if (counters.sinceLastLegendary >= SOFT_PITY_START.legendary) {
    const steps = counters.sinceLastLegendary - SOFT_PITY_START.legendary;
    bonuses.legendary = steps * SOFT_PITY_RATE_PER_STEP.legendary;
  }

  // 闪光软保底：第 600 次起，每次额外 +0.05%
  if (counters.totalDropsWithoutShiny >= SOFT_PITY_START.shiny) {
    const steps = counters.totalDropsWithoutShiny - SOFT_PITY_START.shiny;
    bonuses.shiny = steps * SOFT_PITY_RATE_PER_STEP.shiny;
  }

  return bonuses;
}

/**
 * 更新保底计数器
 *
 * 掉落后递增所有计数器，然后重置对应品质及以下的计数器
 */
export function updatePityCounters(counters: PityCounters, droppedQuality: MonsterQuality, isShiny: boolean): void {
  // 递增所有计数器
  counters.sinceLastRare += 1;
  counters.sinceLastEpic += 1;
  counters.sinceLastLegendary += 1;
  counters.totalDropsWithoutShiny += 1;

  // 根据掉落品质重置对应计数器
  const qualityIndex = QUALITY_ORDER.indexOf(droppedQuality);

  if (isShiny || droppedQuality === 'shiny') {
    counters.totalDropsWithoutShiny = 0;
  }

  if (qualityIndex >= QUALITY_ORDER.indexOf('legendary')) {
    counters.sinceLastLegendary = 0;
  }

  if (qualityIndex >= QUALITY_ORDER.indexOf('epic')) {
    counters.sinceLastEpic = 0;
  }

  if (qualityIndex >= QUALITY_ORDER.indexOf('rare')) {
    counters.sinceLastRare = 0;
  }
}

/**
 * 应用保底减半 buff（观音菩萨收徒效果）
 */
export function applyPityReduction(counters: PityCounters, reductionFactor: number): PityCounters {
  return {
    sinceLastRare: Math.floor(counters.sinceLastRare * reductionFactor),
    sinceLastEpic: Math.floor(counters.sinceLastEpic * reductionFactor),
    sinceLastLegendary: Math.floor(counters.sinceLastLegendary * reductionFactor),
    totalDropsWithoutShiny: Math.floor(counters.totalDropsWithoutShiny * reductionFactor),
  };
}
