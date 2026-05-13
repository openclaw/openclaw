/**
 * 成就判定引擎
 *
 * 每次操作后检查是否解锁新成就。
 * 成就分为：修行成就、收集成就、产品成就、隐藏成就。
 */

import type { Achievement, AchievementCondition, UserProfile, UserCollection, HistoryRecord } from './types.ts';
import { PRODUCT_BASE_EXP } from './types.ts';

/**
 * 成就数据（内联）
 */
const allAchievements: Achievement[] = [
  // 修行成就
  { id: "A001", name: "初出茅庐", emoji: "🐒", description: "首次成功调用 dws CLI", category: "cultivation", condition: { type: "totalOperations", count: 1 }, expReward: 10 },
  { id: "A002", name: "三天打鱼", emoji: "🔥", description: "连续 3 天签到", category: "cultivation", condition: { type: "consecutiveSignIn", days: 3 }, expReward: 15 },
  { id: "A003", name: "七七四十九", emoji: "📅", description: "连续 49 天签到", category: "cultivation", condition: { type: "consecutiveSignIn", days: 49 }, expReward: 200 },
  { id: "A004", name: "十连斩", emoji: "⚡", description: "单次连击达到 10 次", category: "cultivation", condition: { type: "maxCombo", count: 10 }, expReward: 50 },
  { id: "A005", name: "五行山下", emoji: "🏔️", description: "累计 500 次成功调用", category: "cultivation", condition: { type: "totalOperations", count: 500 }, expReward: 100 },
  { id: "A006", name: "八十一难", emoji: "🌋", description: "累计 81 次 recovery 成功", category: "cultivation", condition: { type: "totalRecoveries", count: 81 }, expReward: 300 },
  // 收集成就
  { id: "A101", name: "妖怪猎人", emoji: "📖", description: "收服 10 种不同妖怪", category: "collection", condition: { type: "uniqueMonsters", count: 10 }, expReward: 30 },
  { id: "A102", name: "半部西游", emoji: "📚", description: "收服 24 种不同妖怪", category: "collection", condition: { type: "uniqueMonsters", count: 24 }, expReward: 100 },
  { id: "A103", name: "妖魔全书", emoji: "📜", description: "收服全部 48 种妖怪", category: "collection", condition: { type: "uniqueMonsters", count: 48 }, expReward: 500, titleReward: "妖魔克星" },
  { id: "A104", name: "闪光猎人", emoji: "✨", description: "收服 1 只闪光妖怪", category: "collection", condition: { type: "shinyMonsters", count: 1 }, expReward: 200 },
  { id: "A105", name: "闪光大师", emoji: "🌈", description: "收服 5 只闪光妖怪", category: "collection", condition: { type: "shinyMonsters", count: 5 }, expReward: 500, titleReward: "欧皇" },
  { id: "A106", name: "全闪通关", emoji: "👑", description: "收服 10 只闪光妖怪", category: "collection", condition: { type: "shinyMonsters", count: 10 }, expReward: 1000, titleReward: "天选之人" },
  // 产品成就
  { id: "A201", name: "表格大师", emoji: "📊", description: "aitable 相关命令成功 50 次", category: "product", condition: { type: "productUsage", product: "aitable", count: 50 }, expReward: 30 },
  { id: "A202", name: "时间管理者", emoji: "📅", description: "calendar 相关命令成功 50 次", category: "product", condition: { type: "productUsage", product: "calendar", count: 50 }, expReward: 30 },
  { id: "A203", name: "群聊达人", emoji: "💬", description: "chat 相关命令成功 50 次", category: "product", condition: { type: "productUsage", product: "chat", count: 50 }, expReward: 30 },
  { id: "A204", name: "待办终结者", emoji: "✅", description: "todo 相关命令成功 50 次", category: "product", condition: { type: "productUsage", product: "todo", count: 50 }, expReward: 30 },
  { id: "A205", name: "日报之王", emoji: "📝", description: "report 连续 30 天提交", category: "product", condition: { type: "consecutiveReport", days: 30 }, expReward: 100 },
  { id: "A206", name: "全能战士", emoji: "🎯", description: "使用过所有 11 个产品", category: "product", condition: { type: "allProducts" }, expReward: 200 },
  // 隐藏成就
  { id: "A301", name: "夜猫子", emoji: "🌙", description: "凌晨 2:00-5:00 成功调用", category: "hidden", condition: { type: "nightOwl" }, expReward: 20 },
  { id: "A302", name: "非酋翻身", emoji: "🎰", description: "触发天命保底（150 次未出传说）", category: "hidden", condition: { type: "pityTriggered" }, expReward: 100, titleReward: "大器晚成" },
  { id: "A303", name: "屡败屡战", emoji: "💀", description: "连续 10 次失败后第 11 次成功", category: "hidden", condition: { type: "consecutiveFailThenSuccess", failCount: 10 }, expReward: 50 },
  { id: "A304", name: "屠龙勇士", emoji: "🐉", description: "单日收服 3 只稀有及以上妖怪", category: "hidden", condition: { type: "dailyRareOrAbove", count: 3 }, expReward: 100 },
  { id: "A305", name: "生日快乐", emoji: "🎂", description: "在账号注册日当天使用", category: "hidden", condition: { type: "birthday" }, expReward: 50 },
  // v2: 逃跑相关成就
  { id: "A401", name: "逃跑大师", emoji: "💨", description: "累计被妖怪逃跑 50 次", category: "hidden", condition: { type: "totalEscapes", count: 50 }, expReward: 30 },
  { id: "A402", name: "一网打尽", emoji: "🪤", description: "连续 10 次掉落无妖怪逃跑", category: "hidden", condition: { type: "consecutiveNoEscape", count: 10 }, expReward: 50 },
  // v2: 悬赏令相关成就
  { id: "A403", name: "赏金猎人", emoji: "📜", description: "累计完成 30 张悬赏令", category: "hidden", condition: { type: "totalBountiesCompleted", count: 30 }, expReward: 100, titleReward: "赏金猎人" },
  { id: "A404", name: "金牌猎人", emoji: "🥇", description: "累计完成 10 张金令", category: "hidden", condition: { type: "goldBountiesCompleted", count: 10 }, expReward: 150 },
  { id: "A405", name: "全勤猎人", emoji: "📅", description: "连续 7 天每日完成全部 3 张悬赏令", category: "hidden", condition: { type: "consecutiveFullClear", days: 7 }, expReward: 200 },
  // v2: 随机事件相关成就
  { id: "A406", name: "见多识广", emoji: "🎪", description: "累计触发 10 次随机事件", category: "hidden", condition: { type: "totalEventsTriggered", count: 10 }, expReward: 30 },
  { id: "A407", name: "百战百胜", emoji: "⚔️", description: "累计完成 10 次挑战事件", category: "hidden", condition: { type: "challengesCompleted", count: 10 }, expReward: 100, titleReward: "战神" },
  { id: "A408", name: "劫后余生", emoji: "😈", description: "触发「走火入魔」后存活（修行值未归零）", category: "hidden", condition: { type: "survivedMadness" }, expReward: 50, titleReward: "大难不死" },
  { id: "A409", name: "蟠桃常客", emoji: "🍑", description: "累计触发 3 次「蟠桃大会」", category: "hidden", condition: { type: "specificEventCount", eventId: "EV001", count: 3 }, expReward: 80 },
  { id: "A410", name: "火焰山主", emoji: "🔥", description: "累计完成 3 次「火焰山」挑战", category: "hidden", condition: { type: "specificEventCount", eventId: "EV102", count: 3 }, expReward: 60 },
  { id: "A411", name: "真假悟空", emoji: "🐒", description: "在「真假美猴王」事件中选对", category: "hidden", condition: { type: "specificChallengeSuccess", eventId: "EV104" }, expReward: 100, titleReward: "火眼金睛" },
  { id: "A412", name: "否极泰来", emoji: "🌈", description: "灾厄事件结束后立即触发增益事件", category: "hidden", condition: { type: "disasterThenBlessing" }, expReward: 200 },
  { id: "A413", name: "化险为夷", emoji: "🛡️", description: "累计 5 次通过化解方式提前解除灾厄", category: "hidden", condition: { type: "disastersResolved", count: 5 }, expReward: 80 },
];

/**
 * 获取所有成就
 */
export function getAllAchievements(): Achievement[] {
  return allAchievements;
}

/**
 * 根据 ID 查找成就
 */
export function getAchievementById(achievementId: string): Achievement | undefined {
  return allAchievements.find(a => a.id === achievementId);
}

/**
 * 检查单个成就条件是否满足
 */
function isConditionMet(
  condition: AchievementCondition,
  profile: UserProfile,
  collection: UserCollection,
  todayRecords: HistoryRecord[]
): boolean {
  switch (condition.type) {
    case 'totalOperations':
      return profile.totalOperations >= condition.count;

    case 'consecutiveSignIn':
      return profile.consecutiveSignInDays >= condition.days;

    case 'maxCombo':
      return profile.maxCombo >= condition.count;

    case 'totalRecoveries':
      return profile.totalRecoveries >= condition.count;

    case 'uniqueMonsters': {
      const uniqueNonShiny = collection.entries.filter(e => !e.isShiny).length;
      return uniqueNonShiny >= condition.count;
    }

    case 'shinyMonsters': {
      const shinyCount = collection.entries.filter(e => e.isShiny).length;
      return shinyCount >= condition.count;
    }

    case 'productUsage': {
      const usage = profile.productUsage[condition.product] ?? 0;
      return usage >= condition.count;
    }

    case 'allProducts': {
      const allProducts = Object.keys(PRODUCT_BASE_EXP);
      return allProducts.every(p => (profile.productUsage[p] ?? 0) > 0);
    }

    case 'dailyOperations': {
      return todayRecords.filter(r => r.success).length >= condition.count;
    }

    case 'nightOwl': {
      const hour = new Date().getHours();
      return hour >= 2 && hour < 5;
    }

    case 'pityTriggered':
      // 由掉落引擎在触发天命保底时标记
      return false;

    case 'consecutiveFailThenSuccess':
      return profile.consecutiveFailures >= condition.failCount;

    case 'dailyRareOrAbove': {
      const rareOrAboveToday = todayRecords.filter(r => {
        if (!r.monsterId) return false;
        // 简化判断：monsterId 以 S/E/L 开头的是稀有及以上
        return r.monsterId.startsWith('S') || r.monsterId.startsWith('E') || r.monsterId.startsWith('L');
      });
      return rareOrAboveToday.length >= condition.count;
    }

    case 'birthday': {
      const createdDate = new Date(profile.createdAt);
      const now = new Date();
      return (
        createdDate.getMonth() === now.getMonth() &&
        createdDate.getDate() === now.getDate() &&
        now.getFullYear() > createdDate.getFullYear()
      );
    }

    case 'consecutiveReport': {
      const reportUsage = profile.productUsage['report'] ?? 0;
      return reportUsage >= condition.days;
    }

    // v2: 逃跑相关
    case 'totalEscapes':
      return profile.totalEscapes >= condition.count;

    case 'consecutiveNoEscape':
      // 由主引擎在连续无逃跑时通过 triggerSpecialAchievement 触发
      return false;

    // v2: 悬赏令相关
    case 'totalBountiesCompleted':
      return profile.bountyHistory.totalCompleted >= condition.count;

    case 'goldBountiesCompleted':
      return profile.bountyHistory.goldCompleted >= condition.count;

    case 'consecutiveFullClear':
      return profile.bountyHistory.consecutiveFullClear >= condition.days;

    // v2: 随机事件相关
    case 'totalEventsTriggered':
      return profile.eventStats.totalTriggered >= condition.count;

    case 'challengesCompleted':
      return profile.eventStats.challengesCompleted >= condition.count;

    case 'survivedMadness': {
      // 触发过"走火入魔"且修行值 > 0
      const hadMadness = profile.eventHistory.some(e => e.eventId === 'EV206');
      return hadMadness && profile.totalExp > 0;
    }

    case 'specificEventCount': {
      const eventCount = profile.eventHistory.filter(e => e.eventId === condition.eventId).length;
      return eventCount >= condition.count;
    }

    case 'specificChallengeSuccess': {
      return profile.eventHistory.some(
        e => e.eventId === condition.eventId && e.outcome === 'success'
      );
    }

    case 'disasterThenBlessing':
      // 由主引擎在灾厄结束后立即触发增益时通过 triggerSpecialAchievement 触发
      return false;

    case 'disastersResolved':
      return profile.eventStats.disastersResolved >= condition.count;

    default:
      return false;
  }
}

/**
 * 检查所有未解锁的成就，返回新解锁的成就列表
 */
export function checkAchievements(
  profile: UserProfile,
  collection: UserCollection,
  todayRecords: HistoryRecord[]
): Achievement[] {
  const newlyUnlocked: Achievement[] = [];

  for (const achievement of allAchievements) {
    // 跳过已解锁的
    if (profile.unlockedAchievements.includes(achievement.id)) {
      continue;
    }

    // 检查条件
    if (isConditionMet(achievement.condition, profile, collection, todayRecords)) {
      newlyUnlocked.push(achievement);
      profile.unlockedAchievements.push(achievement.id);
    }
  }

  return newlyUnlocked;
}

/**
 * 手动触发特殊成就（如保底触发）
 */
export function triggerSpecialAchievement(
  profile: UserProfile,
  achievementId: string
): Achievement | null {
  if (profile.unlockedAchievements.includes(achievementId)) {
    return null;
  }

  const achievement = getAchievementById(achievementId);
  if (!achievement) return null;

  profile.unlockedAchievements.push(achievementId);
  return achievement;
}
