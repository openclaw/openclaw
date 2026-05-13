/**
 * 概率掉落引擎（核心）
 *
 * 每次 dws CLI 成功执行后触发一次"降妖"事件。
 * 流程：保底判定 → 随机品质 → 等级门槛降级 → 加权选妖 → 闪光判定 → 更新计数器
 */

import { randomBytes } from 'crypto';
import type {
  MonsterQuality, Monster, UserProfile, DropResult,
  Buff, UserCollection, EscapeModifier,
} from './types.ts';
import {
  DROP_RATES, QUALITY_LEVEL_GATES, QUALITY_ORDER,
} from './types.ts';
import { checkPityTrigger, updatePityCounters, getSoftPityBonuses } from './pity-counter.ts';
import { getMonstersByQuality, getWeeklyUpMonster, weightedRandomSelect } from './monster-pool.ts';
import { getQualityBoost, getQualityCap, isDropSuppressed } from './random-event-engine.ts';

/**
 * 使用 crypto.randomBytes 生成安全随机数
 */
function cryptoRandom(): number {
  const buffer = randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
}

/**
 * 根据随机数和用户等级判定掉落品质
 *
 * v2: 集成软保底概率加成
 */
function resolveQuality(roll: number, level: number, buffs: Buff[], softPityBonuses: Partial<Record<MonsterQuality, number>>): MonsterQuality {
  // 计算 buff 加成后的掉落率
  const rateBonus: Partial<Record<MonsterQuality, number>> = {};
  for (const buff of buffs) {
    switch (buff.effect) {
      case 'epicRateBonus':
        rateBonus.epic = (rateBonus.epic ?? 0) + buff.value;
        break;
      case 'rareRateBonus':
        rateBonus.rare = (rateBonus.rare ?? 0) + buff.value;
        break;
      case 'legendaryRateBonus':
        rateBonus.legendary = (rateBonus.legendary ?? 0) + buff.value;
        break;
      case 'shinyRateBonus':
        rateBonus.shiny = (rateBonus.shiny ?? 0) + buff.value;
        break;
      case 'allRateBonus':
        for (const quality of QUALITY_ORDER) {
          if (quality !== 'normal' && quality !== 'fine') {
            rateBonus[quality] = (rateBonus[quality] ?? 0) + buff.value;
          }
        }
        break;
    }
  }

  // 合并软保底加成
  for (const [quality, bonus] of Object.entries(softPityBonuses)) {
    const qualityKey = quality as MonsterQuality;
    rateBonus[qualityKey] = (rateBonus[qualityKey] ?? 0) + (bonus ?? 0);
  }

  // 从高品质到低品质依次判定
  let cumulative = 0;
  const qualitiesHighToLow: MonsterQuality[] = ['shiny', 'legendary', 'epic', 'rare', 'fine', 'normal'];

  for (const quality of qualitiesHighToLow) {
    const baseRate = DROP_RATES[quality];
    const bonus = rateBonus[quality] ?? 0;
    cumulative += baseRate + bonus;

    if (roll < cumulative) {
      return quality;
    }
  }

  return 'normal';
}

/**
 * 应用等级门槛降级
 */
function applyLevelGate(quality: MonsterQuality, level: number): MonsterQuality {
  const gate = QUALITY_LEVEL_GATES[quality];
  if (gate !== undefined && level < gate) {
    // 降级到最高可用品质
    const qualityIndex = QUALITY_ORDER.indexOf(quality);
    for (let i = qualityIndex - 1; i >= 0; i--) {
      const lowerQuality = QUALITY_ORDER[i];
      const lowerGate = QUALITY_LEVEL_GATES[lowerQuality];
      if (lowerGate === undefined || level >= lowerGate) {
        return lowerQuality;
      }
    }
    return 'normal';
  }
  return quality;
}

/**
 * 检查玲珑宝塔 buff：普通掉落有概率升级为精良
 */
function checkNormalUpgrade(quality: MonsterQuality, buffs: Buff[]): MonsterQuality {
  if (quality !== 'normal') return quality;

  const upgradeChance = buffs
    .filter(b => b.effect === 'normalUpgrade')
    .reduce((sum, b) => sum + b.value, 0);

  if (upgradeChance > 0 && cryptoRandom() < upgradeChance) {
    return 'fine';
  }
  return quality;
}

/**
 * 将品质提升一级（用于月光宝盒事件）
 */
function boostQuality(quality: MonsterQuality): MonsterQuality {
  const index = QUALITY_ORDER.indexOf(quality);
  if (index < 0 || index >= QUALITY_ORDER.length - 1) return quality;
  return QUALITY_ORDER[index + 1];
}

/**
 * 执行一次掉落
 *
 * v2: 集成软保底概率加成、事件品质提升/上限、禁止掉落检查
 */
export function executeDrop(
  product: string,
  profile: UserProfile,
  collection: UserCollection
): DropResult {
  const emptyResult: DropResult = {
    monster: { id: '', name: '', quality: 'normal', origin: '', relatedProduct: null, captureQuote: '' },
    isShiny: false, isNew: false, expGained: 0,
    isPityTriggered: false, isUpMonster: false,
    escaped: false, escapeRate: 0, escapeModifiers: [],
  };

  // v2: 检查是否被事件禁止掉落（五行山镇压）
  if (isDropSuppressed(profile)) {
    return emptyResult;
  }

  const pity = profile.pityCounters;
  let isPityTriggered = false;
  let quality: MonsterQuality;

  // 1. 保底判定（优先级最高）
  const pityQuality = checkPityTrigger(pity);
  if (pityQuality) {
    quality = pityQuality;
    isPityTriggered = true;
  } else {
    // 2. 随机品质判定（v2: 含软保底加成）
    const roll = cryptoRandom();
    const softPityBonuses = getSoftPityBonuses(pity);
    quality = resolveQuality(roll, profile.level, profile.buffs, softPityBonuses);
  }

  // 3. 等级门槛降级
  quality = applyLevelGate(quality, profile.level);

  // 4. 玲珑宝塔 buff 检查
  quality = checkNormalUpgrade(quality, profile.buffs);

  // v2: 事件品质上限（妖雾弥漫）
  const qualityCap = getQualityCap(profile);
  if (qualityCap) {
    const capIndex = QUALITY_ORDER.indexOf(qualityCap);
    const currentIndex = QUALITY_ORDER.indexOf(quality);
    if (currentIndex > capIndex) {
      quality = qualityCap;
    }
  }

  // v2: 事件品质提升（月光宝盒）
  const qualityBoostLevel = getQualityBoost(profile);
  if (qualityBoostLevel > 0) {
    for (let i = 0; i < qualityBoostLevel; i++) {
      quality = boostQuality(quality);
    }
    quality = applyLevelGate(quality, profile.level);
  }

  // 5. 闪光判定（独立于品质判定）
  let isShiny = false;
  if (quality === 'shiny') {
    isShiny = true;
    const availableQualities = QUALITY_ORDER.filter(q => {
      if (q === 'shiny') return false;
      const gate = QUALITY_LEVEL_GATES[q];
      return gate === undefined || profile.level >= gate;
    });
    quality = availableQualities[Math.floor(cryptoRandom() * availableQualities.length)] || 'normal';
  } else if (profile.level >= 9) {
    const shinyBonus = profile.buffs
      .filter(b => b.effect === 'shinyRateBonus')
      .reduce((sum, b) => sum + b.value, 0);
    if (cryptoRandom() < 0.001 + shinyBonus) {
      isShiny = true;
    }
  }

  // 6. 在品质池中选择妖怪
  const pool = getMonstersByQuality(quality);
  const upMonster = getWeeklyUpMonster();
  let monster: Monster;

  if (pool.length === 0) {
    const normalPool = getMonstersByQuality('normal');
    monster = weightedRandomSelect(normalPool, product, null, cryptoRandom());
  } else {
    monster = weightedRandomSelect(pool, product, upMonster, cryptoRandom());
  }

  // 7. 判定是否为新妖怪
  const isNew = !collection.entries.some(e =>
    e.monsterId === monster.id && (isShiny ? e.isShiny : !e.isShiny)
  );

  // 8. 更新保底计数器
  updatePityCounters(pity, quality, isShiny);

  return {
    monster,
    isShiny,
    isNew,
    expGained: 0,
    isPityTriggered,
    isUpMonster: upMonster?.id === monster.id,
    escaped: false,
    escapeRate: 0,
    escapeModifiers: [],
  };
}
