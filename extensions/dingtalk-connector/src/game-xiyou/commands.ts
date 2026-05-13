/**
 * 聊天命令注册
 *
 * 处理 /修行 /图鉴 /成就 /法宝 /妖魔榜 /机缘 /保底 /使用 /炫耀 等命令。
 */

import type { UserProfile, UserCollection } from './types.ts';
import {
  renderProfilePanel,
  renderCollectionPanel,
  renderAchievementPanel,
  renderTreasurePanel,
  renderPityPanel,
  renderEncounterPanel,
  renderLeaderboard,
  renderTreasureUse,
  renderShowOff,
  renderBountyPanel,
  renderEventPanel,
} from './renderer.ts';
import { consumeTreasure } from './treasure-system.ts';
import { getNextLevel } from './level-system.ts';
import { getMonsterById, getAllMonsters } from './monster-pool.ts';
import type { Monster } from './types.ts';
import { QUALITY_LABELS } from './types.ts';

/** 养成系统支持的命令列表 */
export const GAMIFICATION_COMMANDS = [
  '/修行', '/图鉴', '/成就', '/法宝', '/使用',
  '/妖魔榜', '/机缘', '/保底', '/炫耀',
  '/悬赏', '/事件', '/西游',
];

/**
 * 检查消息是否是养成系统命令
 */
export function isGamificationCommand(text: string): boolean {
  const trimmed = text.trim();
  return GAMIFICATION_COMMANDS.some(cmd => trimmed.startsWith(cmd));
}

/**
 * 处理养成系统命令，返回 Markdown 响应
 *
 * @returns Markdown 字符串，或 null（不是养成系统命令）
 */
export function handleGamificationCommand(
  text: string,
  profile: UserProfile,
  collection: UserCollection,
  saveCallback: () => void
): string | null {
  const trimmed = text.trim();

  if (trimmed === '/修行') {
    return renderProfilePanel(profile, collection);
  }

  if (trimmed === '/图鉴') {
    return renderCollectionPanel(collection);
  }

  if (trimmed.startsWith('/图鉴 ')) {
    const monsterName = trimmed.slice(4).trim();
    return renderMonsterDetail(monsterName, collection);
  }

  if (trimmed === '/成就') {
    return renderAchievementPanel(profile);
  }

  if (trimmed === '/法宝') {
    return renderTreasurePanel(profile);
  }

  if (trimmed.startsWith('/使用 ')) {
    const treasureName = trimmed.slice(4).trim();
    return handleUseTreasure(profile, treasureName, saveCallback);
  }

  if (trimmed === '/妖魔榜') {
    return renderLeaderboard(profile, collection);
  }

  if (trimmed === '/机缘') {
    return renderEncounterPanel(profile);
  }

  if (trimmed === '/保底') {
    return renderPityPanel(profile);
  }

  if (trimmed === '/炫耀') {
    return renderShowOff(profile, collection);
  }

  if (trimmed === '/悬赏' || trimmed === '/悬赏 历史') {
    return renderBountyPanel(profile);
  }

  if (trimmed === '/事件' || trimmed === '/事件 历史') {
    return renderEventPanel(profile);
  }

  // ===== 帮助面板 & 一键开关 =====
  if (trimmed === '/西游' || trimmed === '/西游 --h' || trimmed === '/西游 -h' || trimmed === '/西游 help') {
    const statusText = profile.settings.enabled ? '✅ 已开启' : '❌ 已关闭';
    return [
      `### 🐒 西游妖魔榜 · 命令一览`,
      ``,
      `当前状态：${statusText}`,
      ``,
      `| 命令 | 功能 |`,
      `|------|------|`,
      `| \`/修行\` | 查看个人修行面板（等级、修行值、连击、签到等） |`,
      `| \`/图鉴\` | 查看妖怪图鉴收集进度 |`,
      `| \`/图鉴 妖怪名\` | 查看指定妖怪详情 |`,
      `| \`/成就\` | 查看成就列表及解锁状态 |`,
      `| \`/法宝\` | 查看法宝背包 |`,
      `| \`/使用 法宝名\` | 使用一次性法宝（如蟠桃、人参果） |`,
      `| \`/妖魔榜\` | 查看本周 UP 妖怪、掉落统计、保底状态 |`,
      `| \`/机缘\` | 查看神仙机缘录 |`,
      `| \`/保底\` | 查看保底计数器详情（含软保底状态） |`,
      `| \`/炫耀\` | 生成炫耀卡片 |`,
      `| \`/悬赏\` | 查看今日悬赏令及历史统计 |`,
      `| \`/事件\` | 查看当前活跃事件及事件统计 |`,
      `| \`/西游 开启\` | 开启养成系统 |`,
      `| \`/西游 关闭\` | 关闭养成系统 |`,
      ``,
      `> 关闭后，dws 命令执行不再触发降妖掉落，但已有数据会保留。`,
    ].join('\n');
  }

  if (trimmed === '/西游 开启' || trimmed === '/西游 开') {
    profile.settings.enabled = true;
    saveCallback();
    return [
      `### 🐒 西游妖魔榜 · 已开启`,
      ``,
      `✅ 养成系统已开启！每次使用钉钉产品能力都会触发降妖掉落。`,
      ``,
      `发送 \`/修行\` 查看你的修行面板。`,
    ].join('\n');
  }

  if (trimmed === '/西游 关闭' || trimmed === '/西游 关') {
    profile.settings.enabled = false;
    saveCallback();
    return [
      `### 🐒 西游妖魔榜 · 已关闭`,
      ``,
      `❌ 养成系统已关闭。dws 命令执行不再触发降妖掉落。`,
      ``,
      `你的修行数据已保留，随时可以发送 \`/西游 开启\` 重新开启。`,
    ].join('\n');
  }

  return null;
}

/**
 * 渲染妖怪详情
 */
function renderMonsterDetail(monsterName: string, collection: UserCollection): string {
  // 在所有妖怪中搜索
  const allMonsters = getAllMonsters();
  const monster = allMonsters.find(m => m.name === monsterName);

  if (!monster) {
    return `未找到名为「${monsterName}」的妖怪。`;
  }

  const entry = collection.entries.find(e => e.monsterId === monster.id && !e.isShiny);
  const shinyEntry = collection.entries.find(e => e.monsterId === monster.id && e.isShiny);

  const lines = [
    `### ${QUALITY_LABELS[monster.quality]} ${monster.name}`,
    '',
    `- **出处**：${monster.origin}`,
    `- **关联产品**：${monster.relatedProduct ?? '任意'}`,
    `- **收服台词**："${monster.captureQuote}"`,
    '',
  ];

  if (entry) {
    lines.push(
      `✅ **已收服**`,
      `- 首次收服：${new Date(entry.firstCapturedAt).toLocaleDateString('zh-CN')}`,
      `- 收服次数：${entry.captureCount}`,
    );
  } else {
    lines.push(`❌ **未收服**`);
  }

  if (shinyEntry) {
    lines.push('', `✨ **闪光变体已收服**`);
  }

  return lines.join('\n');
}

/**
 * 处理使用法宝命令
 */
function handleUseTreasure(
  profile: UserProfile,
  treasureName: string,
  saveCallback: () => void
): string {
  const result = consumeTreasure(profile, treasureName);

  if (!result) {
    return `无法使用「${treasureName}」。可能原因：未拥有、已使用、或不是一次性法宝。\n\n发送 \`/法宝\` 查看背包。`;
  }

  const nextLevel = getNextLevel(profile.level);
  const nextLevelExp = nextLevel?.requiredExp ?? null;

  // 保存数据
  saveCallback();

  return renderTreasureUse(treasureName, result.expGained, profile.totalExp, nextLevelExp);
}
