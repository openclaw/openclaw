/**
 * 法宝系统
 *
 * 等级 ≥ 5（天兵）后解锁。法宝来源于神仙赐宝和特殊成就奖励。
 * 一次性法宝通过命令使用，永久法宝自动生效。
 */

import type { UserProfile, Treasure, Buff } from './types.ts';

/**
 * 法宝数据（内联，导出供 encounter-system 引用）
 */
export const TREASURES_DATA: Treasure[] = [
  { id: "jintouyun", name: "筋斗云", source: "菩提祖师赐宝", description: "连击加成额外 +0.5", effect: "comboBonus", value: 0.5, consumable: false },
  { id: "jingping", name: "净瓶", source: "观音菩萨赐宝", description: "recovery 成功时额外 +5 修行值", effect: "expMultiplier", value: 1.1, consumable: false },
  { id: "zijinhulu", name: "紫金葫芦", source: "太上老君赐宝", description: "每日额外 1 次掉落机会", effect: "extraDrop", value: 1, consumable: false },
  { id: "pantao", name: "蟠桃", source: "太白金星赐宝", description: "使用后立即 +50 修行值", effect: "instantExp", value: 50, consumable: true },
  { id: "qiankunquan", name: "乾坤圈", source: "哪吒赐宝", description: "闪光概率 +0.05%", effect: "shinyRateBonus", value: 0.0005, consumable: false },
  { id: "sanjiandao", name: "三尖两刃刀", source: "二郎真君赐宝", description: "CLI 错误自动重试 +1 次", effect: "cliRetry", value: 1, consumable: false },
  { id: "linglongta", name: "玲珑宝塔", source: "托塔天王赐宝", description: "普通掉落 20% 概率升级为精良", effect: "normalUpgrade", value: 0.2, consumable: false },
  { id: "renshenguo", name: "人参果", source: "镇元大仙赐宝", description: "使用后立即 +200 修行值", effect: "instantExp", value: 200, consumable: true },
  { id: "dinghaishenzhen", name: "定海神针", source: "成就「齐天大圣」解锁", description: "所有掉落率 +1%", effect: "allRateBonus", value: 0.01, consumable: false },
  { id: "jingguzhou", name: "紧箍咒", source: "成就「西天取经」解锁", description: "保底计数器速度 ×1.5", effect: "pitySpeed", value: 1.5, consumable: false },
  { id: "bashanshan", name: "芭蕉扇", source: "收服铁扇公主后概率获得", description: "连续签到奖励 ×2", effect: "signInMultiplier", value: 2, consumable: false },
  { id: "zhaoyaojing", name: "照妖镜", source: "收服全部精良妖怪后解锁", description: "掉落时预览下一次的品质", effect: "previewNextQuality", value: 1, consumable: false },
];

const allTreasures: Treasure[] = TREASURES_DATA;

/**
 * 根据 ID 查找法宝
 */
export function getTreasureById(treasureId: string): Treasure | undefined {
  return allTreasures.find(t => t.id === treasureId);
}

/**
 * 获取用户拥有的法宝列表（含详情）
 */
export function getUserTreasures(profile: UserProfile): Treasure[] {
  return profile.treasures
    .map(id => getTreasureById(id))
    .filter((t): t is Treasure => t !== undefined);
}

/**
 * 获取用户可使用的一次性法宝
 */
export function getConsumableTreasures(profile: UserProfile): Treasure[] {
  return getUserTreasures(profile).filter(
    t => t.consumable && !profile.consumedTreasures.includes(t.id)
  );
}

/**
 * 使用一次性法宝
 *
 * @returns 使用结果描述，或 null（法宝不存在/已使用/不可消耗）
 */
export function consumeTreasure(
  profile: UserProfile,
  treasureName: string
): { treasure: Treasure; expGained: number; message: string } | null {
  // 按名称查找法宝
  const treasure = allTreasures.find(t => t.name === treasureName);
  if (!treasure) return null;

  // 检查用户是否拥有
  if (!profile.treasures.includes(treasure.id)) return null;

  // 检查是否可消耗
  if (!treasure.consumable) return null;

  // 检查是否已使用
  if (profile.consumedTreasures.includes(treasure.id)) return null;

  // 标记为已使用
  profile.consumedTreasures.push(treasure.id);

  // 应用效果
  let expGained = 0;
  let message = '';

  if (treasure.effect === 'instantExp') {
    expGained = treasure.value;
    profile.totalExp += expGained;
    message = `修行值 +${expGained}`;
  }

  return { treasure, expGained, message };
}

/**
 * 检查是否有额外掉落机会（紫金葫芦效果）
 */
export function hasExtraDropChance(profile: UserProfile): boolean {
  return profile.buffs.some(b => b.effect === 'extraDrop');
}

/**
 * 检查是否有品质预览能力（照妖镜效果）
 */
export function hasQualityPreview(profile: UserProfile): boolean {
  return profile.buffs.some(b => b.effect === 'previewNextQuality');
}
