/**
 * 修行值计算引擎
 *
 * 计算公式：总修行值 = (基础值 × 连击倍率 × 首次使用倍率 + 签到奖励) × buff 倍率
 */

import type { UserProfile, ExpResult, Buff } from './types.ts';
import { PRODUCT_BASE_EXP, COMBO_MULTIPLIERS } from './types.ts';

/**
 * 获取产品的基础修行值
 */
function getBaseExp(product: string): number {
  return PRODUCT_BASE_EXP[product] ?? 2;
}

/**
 * 计算连击加成倍率
 */
function getComboMultiplier(comboCount: number, buffs: Buff[]): number {
  // 检查是否有连击上限提升 buff
  const comboLimitBonus = buffs
    .filter(b => b.effect === 'comboLimitBonus')
    .reduce((sum, b) => sum + b.value, 0);

  // 检查是否有连击加成 buff
  const comboBonusFromBuffs = buffs
    .filter(b => b.effect === 'comboBonus')
    .reduce((sum, b) => sum + b.value, 0);

  // 基础连击倍率
  let baseMultiplier = 1.0;
  for (const { threshold, multiplier } of COMBO_MULTIPLIERS) {
    if (comboCount >= threshold) {
      baseMultiplier = multiplier;
      break;
    }
  }

  // 如果有连击上限提升，最高倍率可以更高
  if (comboLimitBonus > 0 && comboCount >= 10) {
    baseMultiplier = Math.min(baseMultiplier + comboLimitBonus, 5.0);
  }

  return baseMultiplier + comboBonusFromBuffs;
}

/**
 * 计算首次使用加成
 */
function getFirstUseMultiplier(product: string, productUsage: Record<string, number>): number {
  const usage = productUsage[product] ?? 0;
  return usage === 0 ? 5 : 1;
}

/**
 * 计算签到奖励
 */
function getSignInBonus(profile: UserProfile): number {
  const today = new Date().toISOString().slice(0, 10);
  if (profile.lastSignInDate === today) {
    return 0; // 今天已签到
  }
  return 10; // 每日首次 +10
}

/**
 * 计算连续签到奖励
 */
function getConsecutiveSignInBonus(profile: UserProfile, buffs: Buff[]): number {
  const today = new Date().toISOString().slice(0, 10);
  if (profile.lastSignInDate === today) {
    return 0; // 今天已签到，不重复计算
  }

  const signInMultiplier = buffs
    .filter(b => b.effect === 'signInMultiplier')
    .reduce((max, b) => Math.max(max, b.value), 1);

  const consecutiveDays = profile.consecutiveSignInDays + 1;
  const bonus = Math.min(consecutiveDays * 2, 30);
  return Math.floor(bonus * signInMultiplier);
}

/**
 * 计算 buff 总倍率
 */
function getBuffMultiplier(buffs: Buff[]): number {
  return buffs
    .filter(b => b.effect === 'expMultiplier')
    .reduce((multiplier, b) => multiplier * b.value, 1.0);
}

/**
 * 计算一次操作获得的总修行值
 */
export function calculateExp(product: string, profile: UserProfile): ExpResult {
  const baseExp = getBaseExp(product);
  const comboMultiplier = getComboMultiplier(profile.currentCombo + 1, profile.buffs);
  const firstUseMultiplier = getFirstUseMultiplier(product, profile.productUsage);
  const signInBonus = getSignInBonus(profile);
  const consecutiveSignInBonus = getConsecutiveSignInBonus(profile, profile.buffs);
  const buffMultiplier = getBuffMultiplier(profile.buffs);

  const totalExp = Math.floor(
    (baseExp * comboMultiplier * firstUseMultiplier + signInBonus + consecutiveSignInBonus) * buffMultiplier
  );

  return {
    baseExp,
    comboMultiplier,
    firstUseMultiplier,
    signInBonus,
    consecutiveSignInBonus,
    buffMultiplier,
    totalExp,
  };
}

/**
 * 更新签到状态
 */
export function updateSignInStatus(profile: UserProfile): void {
  const today = new Date().toISOString().slice(0, 10);

  if (profile.lastSignInDate === today) {
    return; // 今天已签到
  }

  // 检查是否连续签到
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (profile.lastSignInDate === yesterday) {
    profile.consecutiveSignInDays += 1;
  } else {
    profile.consecutiveSignInDays = 1;
  }

  profile.lastSignInDate = today;
}
