/**
 * 西游妖魔榜养成系统 · 入口
 *
 * GamificationEngine 是养成系统的门面类，统一协调所有子系统。
 * 对外暴露两个核心方法：
 * - onDwsCommandResult(): 每次 dws CLI 命令执行后调用（成功或失败）
 * - handleCommand(): 处理聊天命令（/修行 /图鉴 等）
 */

import { createHash } from 'crypto';
import { resolveUid, getShortUid } from './uid-resolver.ts';
import { loadProfile, saveProfile, loadCollection, saveCollection, loadHistory, saveHistory } from './storage.ts';
import { calculateExp, updateSignInStatus } from './exp-calculator.ts';
import { checkLevelUp, applyLevelUp } from './level-system.ts';
import { executeDrop } from './drop-engine.ts';
import { checkEncounter, applyEncounterEffects } from './encounter-system.ts';
import { checkAchievements, triggerSpecialAchievement } from './achievement-engine.ts';
import { resolveEscape } from './escape-engine.ts';
import {
  generateDailyBounties, updateBountyProgress, checkBountyDayReset,
  type BountyUpdateContext,
} from './bounty-system.ts';
import {
  checkRandomEvent, tickActiveEvents, tickDropEvents,
  getActiveExpMultiplier, resolveDisasterEvent,
} from './random-event-engine.ts';
import {
  renderDropResult, renderLevelUp, renderEncounter,
  renderNewAchievements, renderBountyComplete, renderEventTrigger,
  renderChallengeResult, renderDisasterResolved,
} from './renderer.ts';
import { isGamificationCommand, handleGamificationCommand } from './commands.ts';
import { getMonsterById } from './monster-pool.ts';
import type {
  UserProfile, UserCollection, UserHistory,
  GamificationOutput, HistoryRecord, CollectionEntry,
  DropResult, Achievement, Bounty, RandomEvent, ChallengeEvent,
  MonsterQuality,
} from './types.ts';

// ============ 单例 ============

let engineInstance: GamificationEngine | null = null;

export class GamificationEngine {
  private profile: UserProfile;
  private collection: UserCollection;
  private history: UserHistory;
  private uidHash: string;

  private constructor(senderId?: string) {
    this.uidHash = resolveUid(senderId);
    this.profile = loadProfile(this.uidHash);
    this.collection = loadCollection(this.uidHash);
    this.history = loadHistory(this.uidHash);
  }

  /**
   * 获取或创建引擎实例
   */
  static getInstance(senderId?: string): GamificationEngine {
    const uidHash = resolveUid(senderId);

    // 如果 senderId 变了（不同用户），重新创建实例
    if (!engineInstance || engineInstance.uidHash !== uidHash) {
      engineInstance = new GamificationEngine(senderId);
    }

    return engineInstance;
  }

  /**
   * 强制重新加载数据（用于多用户场景）
   */
  static getInstanceForUser(senderId: string): GamificationEngine {
    return new GamificationEngine(senderId);
  }

  /**
   * 检查养成系统是否启用
   */
  isEnabled(): boolean {
    return this.profile.settings.enabled;
  }

  /**
   * 检查消息是否是养成系统命令
   */
  isCommand(text: string): boolean {
    return isGamificationCommand(text);
  }

  /**
   * 处理聊天命令，返回 Markdown 响应
   */
  handleCommand(text: string): string | null {
    return handleGamificationCommand(
      text,
      this.profile,
      this.collection,
      () => this.save()
    );
  }

  /**
   * dws CLI 命令执行后调用（核心方法）
   *
   * v2: 集成逃跑机制、悬赏令、随机事件系统
   *
   * @param product - dws 产品名（如 "aitable"、"calendar"）
   * @param success - 命令是否成功
   * @param commandStr - 原始命令字符串（用于生成 hash）
   * @param isRecovery - 是否为 recovery 成功
   * @returns Markdown 字符串（追加到 agent 回复末尾），或空字符串
   */
  onDwsCommandResult(
    product: string,
    success: boolean,
    commandStr: string = '',
    isRecovery: boolean = false
  ): string {
    if (!this.isEnabled()) return '';

    const commandHash = createHash('sha256').update(commandStr).digest('hex').slice(0, 16);

    // v2: 每日悬赏令刷新 & 连续全清检查
    checkBountyDayReset(this.profile);
    generateDailyBounties(this.profile);

    // 处理失败情况
    if (!success) {
      this.profile.currentCombo = 0;
      this.profile.consecutiveFailures += 1;

      // v2: 失败也要更新挑战事件进度
      const eventResults = tickActiveEvents(this.profile, false, product, false);

      this.save();
      return '';
    }

    // ===== 以下为成功执行的处理 =====

    // 1. 更新基础统计
    this.profile.totalOperations += 1;
    this.profile.currentCombo += 1;
    if (this.profile.currentCombo > this.profile.maxCombo) {
      this.profile.maxCombo = this.profile.currentCombo;
    }
    this.profile.productUsage[product] = (this.profile.productUsage[product] ?? 0) + 1;

    if (isRecovery) {
      this.profile.totalRecoveries += 1;
    }

    // 2. 更新签到状态
    updateSignInStatus(this.profile);

    // 3. 计算修行值
    const expResult = calculateExp(product, this.profile);

    // v2: 应用事件修行值倍率（蟠桃大会 ×3 / 紧箍咒发作 ×0.5）
    const eventExpMultiplier = getActiveExpMultiplier(this.profile);
    expResult.totalExp = Math.floor(expResult.totalExp * eventExpMultiplier);

    // 4. 检查升级
    const levelUp = checkLevelUp(this.profile, expResult.totalExp);

    // 5. 应用修行值
    this.profile.totalExp += expResult.totalExp;
    applyLevelUp(this.profile);

    // 6. 执行掉落
    let dropResult = executeDrop(product, this.profile, this.collection);
    dropResult.expGained = expResult.totalExp;

    // v2: 逃跑判定（仅对有效掉落）
    if (dropResult.monster.id) {
      dropResult = resolveEscape(dropResult, this.profile, product);
    }

    // v2: 递减 drop_count 类型事件
    if (dropResult.monster.id) {
      tickDropEvents(this.profile);
    }

    // 7. 更新图鉴（v2: 仅在未逃跑时更新）
    if (dropResult.monster.id && !dropResult.escaped) {
      this.updateCollection(dropResult.monster.id, dropResult.isShiny, commandHash);
    }

    // 逃跑时给安慰奖修行值
    if (dropResult.escaped) {
      this.profile.totalExp += 2;
    }

    // 8. 检查机缘
    const encounter = checkEncounter(this.profile);
    if (encounter) {
      applyEncounterEffects(this.profile, encounter);

      // v2: 机缘可以化解灾厄事件
      const resolvedEvent = resolveDisasterEvent(this.profile, 'trigger_encounter');
      if (resolvedEvent) {
        // 渲染时会展示化解通知
      }
    }

    // v2: 触发随机事件
    const triggeredEvent = checkRandomEvent(this.profile);

    // v2: 处理即时事件效果
    let extraDropResult: DropResult | null = null;
    if (triggeredEvent) {
      // EV003 龙宫寻宝：额外掉落
      if (triggeredEvent.effect.type === 'extra_drop') {
        extraDropResult = executeDrop(product, this.profile, this.collection);
        if (extraDropResult.monster.id && !extraDropResult.escaped) {
          this.updateCollection(extraDropResult.monster.id, extraDropResult.isShiny, commandHash);
        }
      }

      // EV202 金蝉脱壳：移除一只已收服的精良妖怪
      if (triggeredEvent.id === 'EV202') {
        const fineEntries = this.collection.entries.filter(e => {
          const monster = getMonsterById(e.monsterId);
          return monster?.quality === 'fine' && !e.isShiny;
        });
        if (fineEntries.length > 0) {
          const randomIndex = Math.floor(Math.random() * fineEntries.length);
          const removedEntry = fineEntries[randomIndex];
          this.collection.entries = this.collection.entries.filter(e => e !== removedEntry);
          // 接下来 10 次内再次遇到该妖怪概率 ×5（通过 escapeHistory 追踪）
          this.profile.escapeHistory[removedEntry.monsterId] = 1;
        }
      }
    }

    // v2: 更新活跃事件持续时间
    const capturedMonster = dropResult.monster.id !== '' && !dropResult.escaped;
    const eventResults = tickActiveEvents(this.profile, true, product, capturedMonster);

    // v2: 检查"否极泰来"成就（灾厄结束后立即触发增益）
    const hasDisasterExpired = eventResults.some(
      r => (r.event.category === 'disaster') && (r.outcome === 'expired' || r.outcome === 'resolved')
    );
    if (hasDisasterExpired && triggeredEvent?.category === 'blessing') {
      const blessingAchievement = triggerSpecialAchievement(this.profile, 'A412');
      // 成就奖励在下面统一处理
    }

    // 9. 获取今日记录用于成就判定
    const today = new Date().toISOString().slice(0, 10);
    const todayRecords = this.history.records.filter(r => {
      const recordDate = new Date(r.timestamp).toISOString().slice(0, 10);
      return recordDate === today;
    });

    // v2: 构建悬赏令更新上下文
    const todayProducts = new Set<string>();
    const todayQualities = new Set<MonsterQuality>();
    for (const record of todayRecords) {
      if (record.success) todayProducts.add(record.product);
      if (record.monsterId && !record.escaped) {
        const monster = getMonsterById(record.monsterId);
        if (monster) todayQualities.add(monster.quality);
      }
    }
    todayProducts.add(product);
    if (capturedMonster) todayQualities.add(dropResult.monster.quality);

    const bountyContext: BountyUpdateContext = {
      commandSuccess: true,
      product,
      dropResult: capturedMonster ? dropResult : undefined,
      encounterTriggered: encounter !== null,
      encounterType: encounter?.type,
      currentCombo: this.profile.currentCombo,
      todayProducts,
      todayQualities,
    };

    // v2: 更新悬赏令进度
    const completedBounties = updateBountyProgress(this.profile, bountyContext);

    // v2: 完成悬赏令可以化解灾厄事件
    if (completedBounties.length > 0) {
      resolveDisasterEvent(this.profile, 'complete_bounty');
    }

    // 10. 检查成就
    const newAchievements = checkAchievements(this.profile, this.collection, todayRecords);

    // 特殊成就：保底触发
    if (dropResult.isPityTriggered) {
      const pityAchievement = triggerSpecialAchievement(this.profile, 'A302');
      if (pityAchievement) {
        newAchievements.push(pityAchievement);
      }
    }

    // 特殊成就：屡败屡战
    if (this.profile.consecutiveFailures >= 10) {
      const failAchievement = triggerSpecialAchievement(this.profile, 'A303');
      if (failAchievement) {
        newAchievements.push(failAchievement);
      }
    }

    // v2 特殊成就：走火入魔后存活
    if (triggeredEvent?.id === 'EV206' && this.profile.totalExp > 0) {
      const madnessAchievement = triggerSpecialAchievement(this.profile, 'A408');
      if (madnessAchievement) {
        newAchievements.push(madnessAchievement);
      }
    }

    // 成就修行值奖励
    for (const achievement of newAchievements) {
      this.profile.totalExp += achievement.expReward;
    }
    applyLevelUp(this.profile);

    // 重置连续失败计数
    this.profile.consecutiveFailures = 0;

    // 11. 记录历史
    const historyRecord: HistoryRecord = {
      timestamp: Date.now(),
      product,
      commandHash,
      success: true,
      expGained: expResult.totalExp,
      monsterId: dropResult.monster.id || undefined,
      isShiny: dropResult.isShiny || undefined,
      escaped: dropResult.escaped || undefined,
      encounterId: encounter?.immortalId,
      achievementIds: newAchievements.length > 0 ? newAchievements.map(a => a.id) : undefined,
      eventId: triggeredEvent?.id,
      completedBountyIds: completedBounties.length > 0 ? completedBounties.map(b => b.id) : undefined,
    };
    this.history.records.push(historyRecord);

    // 12. 持久化
    this.save();

    // 13. 渲染输出
    return this.renderOutput(
      dropResult, expResult, levelUp, encounter, newAchievements,
      completedBounties, triggeredEvent ?? null, eventResults
    );
  }

  /**
   * 更新图鉴
   */
  private updateCollection(monsterId: string, isShiny: boolean, commandHash: string): void {
    const existingEntry = this.collection.entries.find(
      e => e.monsterId === monsterId && e.isShiny === isShiny
    );

    if (existingEntry) {
      existingEntry.captureCount += 1;
    } else {
      const newEntry: CollectionEntry = {
        monsterId,
        firstCapturedAt: Date.now(),
        captureCount: 1,
        isShiny,
      };
      this.collection.entries.push(newEntry);
    }
  }

  /**
   * 渲染完整输出（追加到 agent 回复末尾的 Markdown）
   *
   * v2: 新增悬赏令完成、随机事件、挑战结果的渲染
   */
  private renderOutput(
    dropResult: DropResult,
    expResult: any,
    levelUp: any,
    encounter: any,
    newAchievements: Achievement[],
    completedBounties: Bounty[],
    triggeredEvent: RandomEvent | ChallengeEvent | null,
    eventResults: Array<{ event: RandomEvent | ChallengeEvent; outcome: string }>
  ): string {
    const parts: string[] = [];

    // 掉落结果（如果设置了静默普通掉落且未逃跑，则跳过）
    const shouldShowDrop = dropResult.monster.id && !(
      this.profile.settings.muteNormalDrops &&
      dropResult.monster.quality === 'normal' &&
      !dropResult.isNew &&
      !dropResult.isShiny &&
      !dropResult.escaped
    );

    if (shouldShowDrop) {
      parts.push(renderDropResult(dropResult, expResult, this.collection));
    }

    // 升级通知
    if (levelUp) {
      parts.push(renderLevelUp(levelUp));
    }

    // 机缘事件
    if (encounter) {
      parts.push(renderEncounter(encounter));
    }

    // v2: 随机事件触发通知
    if (triggeredEvent) {
      parts.push(renderEventTrigger(triggeredEvent));
    }

    // v2: 挑战事件结果
    for (const result of eventResults) {
      if (result.event.category === 'challenge') {
        if (result.outcome === 'success' || result.outcome === 'failure') {
          parts.push(renderChallengeResult(
            result.event as ChallengeEvent,
            result.outcome === 'success'
          ));
        }
      }
      if (result.event.category === 'disaster' && result.outcome === 'resolved') {
        parts.push(renderDisasterResolved(result.event));
      }
    }

    // v2: 悬赏令完成通知
    for (const bounty of completedBounties) {
      parts.push(renderBountyComplete(bounty));
    }

    // 新成就
    if (newAchievements.length > 0) {
      parts.push(renderNewAchievements(newAchievements));
    }

    return parts.join('\n');
  }

  /**
   * 持久化所有数据
   */
  private save(): void {
    saveProfile(this.profile);
    saveCollection(this.collection);
    saveHistory(this.history);
  }
}

// ============ 便捷导出 ============

export { isGamificationCommand } from './commands.ts';
export type { GamificationOutput } from './types.ts';
