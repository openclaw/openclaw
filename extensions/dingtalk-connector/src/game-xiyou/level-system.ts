/**
 * 等级判定与升级事件
 *
 * 根据累计修行值判定当前等级，检测升级事件。
 */

import type { UserProfile, LevelUpResult, LevelDefinition } from './types.ts';
import { LEVEL_DEFINITIONS } from './types.ts';

/**
 * 根据累计修行值计算当前等级
 */
export function calculateLevel(totalExp: number): LevelDefinition {
  let currentLevel = LEVEL_DEFINITIONS[0];
  for (const levelDef of LEVEL_DEFINITIONS) {
    if (totalExp >= levelDef.requiredExp) {
      currentLevel = levelDef;
    } else {
      break;
    }
  }
  return currentLevel;
}

/**
 * 获取下一级的定义（如果已满级则返回 null）
 */
export function getNextLevel(currentLevel: number): LevelDefinition | null {
  const nextIndex = LEVEL_DEFINITIONS.findIndex(l => l.level === currentLevel) + 1;
  if (nextIndex >= LEVEL_DEFINITIONS.length) {
    return null;
  }
  return LEVEL_DEFINITIONS[nextIndex];
}

/**
 * 计算距离下一级还需要多少修行值
 */
export function getExpToNextLevel(totalExp: number): number | null {
  const currentLevel = calculateLevel(totalExp);
  const nextLevel = getNextLevel(currentLevel.level);
  if (!nextLevel) {
    return null; // 已满级
  }
  return nextLevel.requiredExp - totalExp;
}

/**
 * 获取当前等级的进度百分比
 */
export function getLevelProgress(totalExp: number): number {
  const currentLevel = calculateLevel(totalExp);
  const nextLevel = getNextLevel(currentLevel.level);

  if (!nextLevel) {
    return 100; // 已满级
  }

  const levelRange = nextLevel.requiredExp - currentLevel.requiredExp;
  const currentProgress = totalExp - currentLevel.requiredExp;
  return Math.floor((currentProgress / levelRange) * 100);
}

/**
 * 检查是否发生升级，返回升级结果
 */
export function checkLevelUp(profile: UserProfile, expGained: number): LevelUpResult | null {
  const previousLevel = calculateLevel(profile.totalExp);
  const newLevel = calculateLevel(profile.totalExp + expGained);

  if (newLevel.level <= previousLevel.level) {
    return null;
  }

  return {
    previousLevel: previousLevel.level,
    previousTitle: previousLevel.title,
    newLevel: newLevel.level,
    newTitle: newLevel.title,
    unlockDescription: newLevel.unlockDescription,
  };
}

/**
 * 应用升级到 profile
 */
export function applyLevelUp(profile: UserProfile): void {
  const levelDef = calculateLevel(profile.totalExp);
  profile.level = levelDef.level;
  profile.title = levelDef.title;
}
