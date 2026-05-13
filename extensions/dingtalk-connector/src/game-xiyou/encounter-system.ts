/**
 * 神仙机缘系统
 *
 * 等级 ≥ 3（修行者）后解锁。
 * 每次 dws CLI 成功执行，除了掉落妖怪外，还有独立概率触发"神仙机缘"事件。
 */

import { randomBytes } from 'crypto';
import type { Encounter, EncounterType, Immortal, UserProfile, Buff, Treasure } from './types.ts';
import { ENCOUNTER_RATES } from './types.ts';
import { TREASURES_DATA } from './treasure-system.ts';

/**
 * 神仙数据（内联）
 */
const allImmortals: Immortal[] = [
  { id: "G001", name: "菩提祖师", guidanceQuote: "悟性不错，但还差一个筋斗云的距离。", treasureId: "jintouyun", apprenticeBuff: { id: "putizu-apprentice", source: "apprentice", effect: "expMultiplier", value: 1.2 } },
  { id: "G002", name: "观音菩萨", guidanceQuote: "救苦救难，先把待办清了。", treasureId: "jingping", apprenticeBuff: { id: "guanyin-apprentice", source: "apprentice", effect: "pityReduction", value: 0.5 } },
  { id: "G003", name: "太上老君", guidanceQuote: "八卦炉里炼出来的，都是好东西。", treasureId: "zijinhulu", apprenticeBuff: { id: "laojun-apprentice", source: "apprentice", effect: "epicRateBonus", value: 0.01 } },
  { id: "G004", name: "太白金星", guidanceQuote: "玉帝有旨，你的 KPI 不错。", treasureId: "pantao", apprenticeBuff: { id: "taibai-apprentice", source: "apprentice", effect: "signInMultiplier", value: 1.5 } },
  { id: "G005", name: "哪吒三太子", guidanceQuote: "风火轮转得快，但别忘了刹车。", treasureId: "qiankunquan", apprenticeBuff: { id: "nezha-apprentice", source: "apprentice", effect: "comboLimitBonus", value: 1 } },
  { id: "G006", name: "二郎真君", guidanceQuote: "第三只眼看穿一切 bug。", treasureId: "sanjiandao", apprenticeBuff: { id: "erlang-apprentice", source: "apprentice", effect: "rareRateBonus", value: 0.02 } },
  { id: "G007", name: "托塔天王", guidanceQuote: "塔在手，妖魔走。", treasureId: "linglongta", apprenticeBuff: { id: "tuota-apprentice", source: "apprentice", effect: "allRateBonus", value: 0.005 } },
  { id: "G008", name: "镇元大仙", guidanceQuote: "人参果，三千年一开花，三千年一结果。", treasureId: "renshenguo", apprenticeBuff: { id: "zhenyuan-apprentice", source: "apprentice", effect: "legendaryRateBonus", value: 0.003 } },
];

function cryptoRandom(): number {
  const buffer = randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
}

/**
 * 根据 ID 查找神仙
 */
export function getImmortalById(immortalId: string): Immortal | undefined {
  return allImmortals.find(i => i.id === immortalId);
}

/**
 * 获取法宝名称
 */
export function getTreasureName(treasureId: string): string {
  const treasure = TREASURES_DATA.find(t => t.id === treasureId);
  return treasure?.name ?? treasureId;
}

/**
 * 获取法宝描述
 */
export function getTreasureDescription(treasureId: string): string {
  const treasure = TREASURES_DATA.find(t => t.id === treasureId);
  return treasure?.description ?? '';
}

/**
 * 检查是否触发机缘事件
 *
 * @returns 机缘事件，或 null（未触发）
 */
export function checkEncounter(profile: UserProfile): Encounter | null {
  // 等级 < 3 不触发
  if (profile.level < 3) {
    return null;
  }

  // 按概率从高到低判定
  const encounterTypes: EncounterType[] = ['apprentice', 'treasure', 'guidance'];

  for (const encounterType of encounterTypes) {
    const rate = ENCOUNTER_RATES[encounterType];
    if (cryptoRandom() < rate) {
      // 随机选择一位神仙
      const immortal = allImmortals[Math.floor(cryptoRandom() * allImmortals.length)];

      const encounter: Encounter = {
        immortalId: immortal.id,
        type: encounterType,
        occurredAt: Date.now(),
      };

      if (encounterType === 'treasure') {
        encounter.treasureId = immortal.treasureId;
      }

      if (encounterType === 'apprentice') {
        encounter.buffId = immortal.apprenticeBuff.id;
      }

      return encounter;
    }
  }

  return null;
}

/**
 * 应用机缘效果到用户档案
 */
export function applyEncounterEffects(profile: UserProfile, encounter: Encounter): void {
  // 记录机缘
  profile.encounters.push(encounter);

  const immortal = getImmortalById(encounter.immortalId);
  if (!immortal) return;

  if (encounter.type === 'treasure' && encounter.treasureId) {
    // 赐宝：添加法宝到背包
    if (!profile.treasures.includes(encounter.treasureId)) {
      profile.treasures.push(encounter.treasureId);
    }

    // 如果法宝有永久 buff 效果，添加到 buffs
    const treasure = TREASURES_DATA.find(t => t.id === encounter.treasureId);
    if (treasure && !treasure.consumable) {
      const existingBuff = profile.buffs.find(b => b.id === treasure.id);
      if (!existingBuff) {
        profile.buffs.push({
          id: treasure.id,
          source: 'treasure',
          effect: treasure.effect,
          value: treasure.value,
        });
      }
    }
  }

  if (encounter.type === 'apprentice') {
    // 收徒：添加永久 buff
    const buff: Buff = { ...immortal.apprenticeBuff };
    const existingBuff = profile.buffs.find(b => b.id === buff.id);
    if (!existingBuff) {
      profile.buffs.push(buff);
    }
  }
}
