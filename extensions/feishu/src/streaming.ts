/**
 * Streaming Manager - 流式输出管理器
 * 
 * 管理飞书卡片实体的流式更新，包括：
 * - card_id 和 sequence 映射
 * - 节流控制（避免 API 频率限制）
 * - 并发更新保护
 * - 兜底更新（确保最终内容同步）
 */

import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { createCardEntity, updateCardEntity } from "./cardkit.js";

/**
 * 流式输出状态
 */
type StreamingState = {
  cardId: string;
  sequence: number;
  lastUpdateTime: number;
  lastContent: string;
  isFinished: boolean;
  updateLock?: Promise<void>; // 并发更新锁
};

/**
 * 流式输出配置
 */
export type StreamingConfig = {
  /** 启用流式输出（默认 true） */
  enabled?: boolean;
  /** 节流间隔毫秒（默认 500ms，范围 100-5000） */
  throttleMs?: number;
  /** 卡片标题 */
  title?: string;
};

/**
 * 流式输出管理器
 */
export class StreamingManager {
  private states: Map<string, StreamingState> = new Map();
  private defaultThrottleMs: number;
  private defaultTitle: string;

  constructor(config?: StreamingConfig) {
    // 配置验证：throttleMs 范围 100-5000ms
    const rawThrottleMs = config?.throttleMs ?? 500;
    this.defaultThrottleMs = Math.max(100, Math.min(5000, rawThrottleMs));
    this.defaultTitle = config?.title ?? "🤖 AI 助手";
  }

  /**
   * 生成唯一的流式会话 ID
   */
  static generateSessionId(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }

  /**
   * 创建卡片实体并启动流式输出
   * 
   * @returns card_id 如果创建成功，否则 null
   */
  async start(params: {
    cfg: ClawdbotConfig;
    sessionId: string;
    initialContent: string;
    accountId?: string;
  }): Promise<string | null> {
    const { cfg, sessionId, initialContent, accountId } = params;

    // 检查是否已有进行中的流式输出
    const existing = this.states.get(sessionId);
    if (existing && !existing.isFinished) {
      console.warn(`feishu: streaming session ${sessionId} already in progress`);
      return existing.cardId;
    }

    // 创建卡片实体
    const cardId = await createCardEntity({
      cfg,
      content: initialContent,
      title: this.defaultTitle,
      accountId,
    });

    if (!cardId) {
      return null;
    }

    // 记录状态
    this.states.set(sessionId, {
      cardId,
      sequence: 1, // 从 1 开始
      lastUpdateTime: Date.now(),
      lastContent: initialContent,
      isFinished: false,
    });

    return cardId;
  }

  /**
   * 创建带节流的更新回调函数
   * 
   * @param cfg 配置
   * @param sessionId 会话 ID
   * @param throttleMs 节流间隔（可选，覆盖默认值）
   * @returns 回调函数 (content: string, isLast: boolean) => void
   */
  createThrottledCallback(params: {
    cfg: ClawdbotConfig;
    sessionId: string;
    throttleMs?: number;
    accountId?: string;
  }): (content: string, isLast: boolean) => void {
    const { cfg, sessionId, accountId } = params;
    const throttleMs = params.throttleMs ?? this.defaultThrottleMs;

    return (content: string, isLast: boolean) => {
      const state = this.states.get(sessionId);
      if (!state) {
        console.warn(`feishu: streaming session ${sessionId} not found`);
        return;
      }

      // 更新最后内容（用于兜底）
      state.lastContent = content || "正在处理...";

      const now = Date.now();
      const shouldUpdate = isLast || (now - state.lastUpdateTime) >= throttleMs;

      if (!shouldUpdate) {
        // 节流中，等待下次调用
        return;
      }

      // 执行更新
      this._doUpdate(cfg, sessionId, state.lastContent, accountId).catch((err) => {
        console.error(`feishu: streaming update error: ${String(err)}`);
      });
    };
  }

  /**
   * 执行卡片更新（带并发保护）
   */
  private async _doUpdate(
    cfg: ClawdbotConfig,
    sessionId: string,
    content: string,
    accountId?: string,
  ): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;

    // 等待之前的更新完成（并发保护）
    if (state.updateLock) {
      await state.updateLock;
    }

    // 递增 sequence
    state.sequence += 1;

    // 创建更新锁
    const updatePromise = updateCardEntity({
      cfg,
      cardId: state.cardId,
      content,
      sequence: state.sequence,
      accountId,
    })
      .then((success) => {
        if (success) {
          state.lastUpdateTime = Date.now();
        } else {
          // 更新失败，sequence 回退（下次重试）
          state.sequence -= 1;
        }
      })
      .finally(() => {
        // 清理锁
        if (state.updateLock === updatePromise) {
          state.updateLock = undefined;
        }
      });

    state.updateLock = updatePromise;
    await updatePromise;
  }

  /**
   * 结束流式输出（兜底更新）
   * 
   * 确保最终内容已同步到飞书
   */
  async finish(params: {
    cfg: ClawdbotConfig;
    sessionId: string;
    finalContent: string;
    accountId?: string;
  }): Promise<void> {
    const { cfg, sessionId, finalContent, accountId } = params;
    const state = this.states.get(sessionId);

    if (!state) {
      console.warn(`feishu: streaming session ${sessionId} not found`);
      return;
    }

    // 等待之前的更新完成
    if (state.updateLock) {
      await state.updateLock;
    }

    // 标记为完成
    state.isFinished = true;

    // 兜底更新：确保最终内容已同步
    state.sequence += 1;
    await updateCardEntity({
      cfg,
      cardId: state.cardId,
      content: finalContent || "处理完成",
      sequence: state.sequence,
      accountId,
    });

    // 清理状态（保留一段时间以便调试）
    setTimeout(() => {
      this.states.delete(sessionId);
    }, 60000); // 1 分钟后清理
  }

  /**
   * 获取卡片 ID
   */
  getCardId(sessionId: string): string | undefined {
    return this.states.get(sessionId)?.cardId;
  }

  /**
   * 获取当前 sequence
   */
  getSequence(sessionId: string): number | undefined {
    return this.states.get(sessionId)?.sequence;
  }

  /**
   * 清理所有状态
   */
  clear(): void {
    this.states.clear();
  }
}

/**
 * 全局流式管理器实例
 */
export const globalStreamingManager = new StreamingManager();
