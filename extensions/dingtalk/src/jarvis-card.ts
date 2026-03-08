/**
 * Jarvis 统一任务面板卡片（简化版）
 *
 * 替代 MultiTaskCardManager + TaskNotifier 双轨制，
 * 实现"一次用户请求 = 一张卡片"的贾维斯式交互。
 *
 * 核心职责:
 * - 创建并投放 AI Card 实例
 * - 管理任务列表状态
 * - 实时更新卡片内容（流式 Markdown）
 * - 完成时切换到最终态
 * - 处理按钮回调动作
 *
 * 优化点：
 * - 统一单/多任务模式，简化逻辑
 * - 智能刷新合并，减少 API 调用
 * - 实时状态同步
 */

import type { TaskStatus } from "./async-task-queue.js";
import { createAICard, streamAICard, updateCardWithButtons, type AICardInstance } from "./card.js";
import {
  renderJarvisCardMarkdown,
  buildFinishButtons,
  buildRunningButtons,
  calculateTaskStats,
  type TaskLineData,
  type JarvisCardData,
  type JarvisActionParams,
  JarvisActionId,
} from "./jarvis-card-template.js";
import type { Logger } from "./shared/index.js";
import type { DingtalkConfig } from "./types.js";

/**
 * Jarvis 卡片配置
 */
export interface JarvisCardConfig {
  /** 卡片标题 */
  title: string;
  /** 最小刷新间隔（毫秒），防止过于频繁的 API 调用 */
  minRefreshIntervalMs: number;
  /** 自动刷新间隔（毫秒），0 表示不自动刷新 */
  autoRefreshIntervalMs: number;
}

const DEFAULT_CONFIG: JarvisCardConfig = {
  title: "Jarvis 任务面板",
  minRefreshIntervalMs: 500,
  autoRefreshIntervalMs: 0,
};

/**
 * 添加任务的参数
 */
export interface AddTaskParams {
  taskId: string;
  description: string;
  type?: string;
}

/**
 * Jarvis 统一任务面板卡片
 */
export class JarvisCard {
  private cardInstance: AICardInstance | null = null;
  private tasks: Map<string, TaskLineData> = new Map();
  private config: JarvisCardConfig;
  private logger?: Logger;
  private lastRefreshTime = 0;
  private lastRenderedContent = "";
  private isFinished = false;
  private autoRefreshTimer?: ReturnType<typeof setInterval>;
  private taskStartTimes: Map<string, number> = new Map();

  /** 卡片创建时间戳（用于计算总耗时） */
  private cardStartedAt: number = Date.now();

  /** 卡片创建参数（用于回调时重建上下文） */
  private conversationType: "1" | "2" = "2";
  private conversationId = "";
  private senderId?: string;

  /** 待刷新标记（用于智能合并刷新请求） */
  private pendingRefresh = false;
  private pendingRefreshForce = false;

  constructor(config?: Partial<JarvisCardConfig>, logger?: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * 创建并投放卡片
   */
  async create(params: {
    cfg: DingtalkConfig;
    conversationType: "1" | "2";
    conversationId: string;
    senderId?: string;
    initialTasks?: AddTaskParams[];
  }): Promise<boolean> {
    const { cfg, conversationType, conversationId, senderId, initialTasks } = params;

    if (this.cardInstance) {
      this.logger?.debug("[JarvisCard] Card already exists, reusing");
      return true;
    }

    // 保存上下文并初始化时间戳
    this.conversationType = conversationType;
    this.conversationId = conversationId;
    this.senderId = senderId;
    this.cardStartedAt = Date.now();
    this.pendingRefresh = false;
    this.pendingRefreshForce = false;

    try {
      this.cardInstance = await createAICard({
        cfg,
        conversationType,
        conversationId,
        senderId,
        senderStaffId: senderId,
        log: (msg) => this.logger?.debug(msg),
      });

      if (!this.cardInstance) {
        this.logger?.error("[JarvisCard] Failed to create AI Card");
        return false;
      }

      // 添加初始任务
      if (initialTasks) {
        for (const task of initialTasks) {
          this.addTask(task);
        }
      }

      // 发送初始内容
      await this.refresh();

      this.logger?.debug(`[JarvisCard] Card created with ${this.tasks.size} tasks`);
      return true;
    } catch (error) {
      this.logger?.error(`[JarvisCard] Error creating card: ${error}`);
      return false;
    }
  }

  /**
   * 添加任务
   */
  addTask(params: AddTaskParams): void {
    if (this.isFinished) {
      this.logger?.warn("[JarvisCard] Cannot add task to finished card");
      return;
    }

    const taskLine: TaskLineData = {
      taskId: params.taskId,
      description: params.description,
      status: "pending",
      progress: 0,
    };

    this.tasks.set(params.taskId, taskLine);
    this.logger?.debug(`[JarvisCard] Task added: ${params.taskId} - ${params.description}`);
  }

  /**
   * 更新任务状态
   */
  updateTask(
    taskId: string,
    updates: Partial<Pick<TaskLineData, "status" | "progress" | "resultSummary" | "errorMessage">>,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.logger?.warn(`[JarvisCard] Task not found: ${taskId}`);
      return;
    }

    // 记录任务开始时间
    if (updates.status === "running" && task.status !== "running") {
      this.taskStartTimes.set(taskId, Date.now());
    }

    // 计算耗时
    if (
      updates.status &&
      (updates.status === "completed" ||
        updates.status === "failed" ||
        updates.status === "cancelled")
    ) {
      const startTime = this.taskStartTimes.get(taskId);
      if (startTime) {
        task.elapsedSeconds = (Date.now() - startTime) / 1000;
        this.taskStartTimes.delete(taskId);
      }
    }

    // 应用更新
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.progress !== undefined) task.progress = updates.progress;
    if (updates.resultSummary !== undefined) task.resultSummary = updates.resultSummary;
    if (updates.errorMessage !== undefined) task.errorMessage = updates.errorMessage;

    this.logger?.debug(`[JarvisCard] Task updated: ${taskId} → ${task.status}`);
  }

  /**
   * 标记任务开始执行
   */
  startTask(taskId: string): void {
    this.updateTask(taskId, { status: "running", progress: 0 });
  }

  /**
   * 标记任务完成
   */
  completeTask(taskId: string, resultSummary?: string): void {
    this.updateTask(taskId, { status: "completed", progress: 100, resultSummary });
  }

  /**
   * 标记任务失败
   */
  failTask(taskId: string, errorMessage?: string): void {
    this.updateTask(taskId, { status: "failed", errorMessage });
  }

  /**
   * 标记任务取消
   */
  cancelTask(taskId: string): void {
    this.updateTask(taskId, { status: "cancelled" });
  }

  /**
   * 刷新卡片显示
   *
   * 受 minRefreshIntervalMs 节流保护，防止过于频繁的 API 调用。
   *
   * 改造：
   * - 运行态使用 updateCardWithButtons 附带取消/暂停按钮
   * - 根据任务状态自动切换卡片状态（PROCESSING/INPUTING）
   */
  async refresh(force: boolean = false): Promise<void> {
    if (!this.cardInstance || this.isFinished) return;

    // 节流检查
    const now = Date.now();
    if (!force && now - this.lastRefreshTime < this.config.minRefreshIntervalMs) {
      return;
    }

    const cardData = this.buildCardData();
    const content = renderJarvisCardMarkdown(cardData);

    // 内容未变化时跳过
    if (content === this.lastRenderedContent) return;

    try {
      const tasks = Array.from(this.tasks.values());
      const stats = calculateTaskStats(tasks);
      const cardInstanceId = this.cardInstance.cardInstanceId;

      // 根据任务状态决定卡片状态
      const hasRunning = stats.running > 0;
      const hasPending = stats.pending > 0;
      const hasActiveButtons = hasRunning || hasPending;

      if (hasActiveButtons) {
        // 运行态：使用 updateCardWithButtons 附带互动按钮
        const cardStatus = hasRunning ? "INPUTING" : "PROCESSING";
        const runningButtons = buildRunningButtons(cardInstanceId, tasks);

        await updateCardWithButtons({
          card: this.cardInstance,
          content,
          status: cardStatus,
          buttons: runningButtons,
          log: (msg) => this.logger?.debug(msg),
        });
      } else {
        // 无活跃任务（全部完成/失败/取消）：使用流式更新
        await streamAICard(this.cardInstance, content, false, (msg) => this.logger?.debug(msg));
      }

      this.lastRenderedContent = content;
      this.lastRefreshTime = now;
      this.logger?.debug("[JarvisCard] Card refreshed");
    } catch (error) {
      this.logger?.error(`[JarvisCard] Error refreshing card: ${error}`);
    }
  }

  /**
   * 完成卡片（所有任务结束后调用）
   *
   * 改造：使用 updateCardWithButtons 替代 finishAICard，
   * 在卡片完成时根据任务结果动态生成互动按钮：
   * - 全部成功 → "继续对话"按钮（primary）
   * - 有失败任务 → "重试失败"按钮（primary）+ "继续对话"按钮（default）
   * - 全部失败 → 使用 FAILED 状态 + "重试失败"按钮
   */
  async finish(summary?: string): Promise<void> {
    if (!this.cardInstance || this.isFinished) return;

    this.isFinished = true;
    this.stopAutoRefresh();

    try {
      const cardData = this.buildCardData();
      const content = summary ?? renderJarvisCardMarkdown(cardData);
      const cardInstanceId = this.cardInstance.cardInstanceId;
      const tasks = Array.from(this.tasks.values());
      const stats = calculateTaskStats(tasks);

      // 根据任务结果决定卡片最终状态和按钮
      const allFailed =
        stats.failed > 0 && stats.completed === 0 && stats.running === 0 && stats.pending === 0;
      const finishStatus = allFailed ? "FAILED" : "FINISHED";
      const finishButtons = buildFinishButtons(cardInstanceId, tasks);

      // 先通过 updateCardWithButtons 设置按钮和最终状态，
      // 必须在关闭流式通道之前完成，否则钉钉 AI Card 进入终态后
      // 不再渲染后续的 cardParamMap 更新（包括 sys_action_list 按钮）。
      await updateCardWithButtons({
        card: this.cardInstance,
        content,
        status: finishStatus,
        buttons: finishButtons,
        log: (msg) => this.logger?.debug(msg),
      });

      // 再关闭流式通道，确保卡片停止 loading 动画
      await streamAICard(this.cardInstance, content, true, (msg) => this.logger?.debug(msg));

      this.logger?.debug(
        `[JarvisCard] Card finished with ${finishButtons.length} buttons, status=${finishStatus}`,
      );
    } catch (error) {
      this.logger?.error(`[JarvisCard] Error finishing card: ${error}`);
    }

    // Clean up from active card registry to prevent memory leak on long-lived gateways
    if (this.conversationId) {
      activeCards.delete(this.conversationId);
    }
  }

  /**
   * 检查是否所有任务都已结束
   */
  areAllTasksDone(): boolean {
    if (this.tasks.size === 0) return false;
    for (const task of this.tasks.values()) {
      if (task.status === "pending" || task.status === "running") return false;
    }
    return true;
  }

  /**
   * 自动完成检查：如果所有任务都结束了，自动 finish 卡片
   */
  async autoFinishIfDone(): Promise<boolean> {
    if (this.areAllTasksDone() && !this.isFinished) {
      await this.finish();
      return true;
    }
    return false;
  }

  /**
   * 处理按钮回调动作
   */
  async handleAction(params: JarvisActionParams): Promise<{ handled: boolean; message?: string }> {
    switch (params.actionId) {
      case JarvisActionId.CANCEL_TASK: {
        if (!params.taskId) return { handled: false, message: "缺少任务 ID" };
        const task = this.tasks.get(params.taskId);
        if (!task) return { handled: false, message: `任务 ${params.taskId} 不存在` };
        if (task.status !== "pending" && task.status !== "running") {
          return { handled: false, message: `任务 ${params.taskId} 已结束，无法取消` };
        }
        this.cancelTask(params.taskId);
        await this.refresh(true);
        return { handled: true, message: `任务 ${params.taskId} 已取消` };
      }

      case JarvisActionId.CANCEL_ALL: {
        let cancelledCount = 0;
        for (const [taskId, task] of this.tasks) {
          if (task.status === "pending" || task.status === "running") {
            this.cancelTask(taskId);
            cancelledCount++;
          }
        }
        await this.refresh(true);
        await this.autoFinishIfDone();
        return { handled: true, message: `已取消 ${cancelledCount} 个任务` };
      }

      case JarvisActionId.RETRY_TASK: {
        if (!params.taskId) return { handled: false, message: "缺少任务 ID" };
        const task = this.tasks.get(params.taskId);
        if (!task) return { handled: false, message: `任务 ${params.taskId} 不存在` };
        if (task.status !== "failed") {
          return { handled: false, message: `任务 ${params.taskId} 未失败，无需重试` };
        }
        // 重置为 pending 状态，由调用方重新入队
        task.status = "pending";
        task.progress = 0;
        task.errorMessage = undefined;
        task.elapsedSeconds = undefined;
        await this.refresh(true);
        return { handled: true, message: `任务 ${params.taskId} 已重新排队` };
      }

      case JarvisActionId.VIEW_DETAIL: {
        if (!params.taskId) return { handled: false, message: "缺少任务 ID" };
        const task = this.tasks.get(params.taskId);
        if (!task) return { handled: false, message: `任务 ${params.taskId} 不存在` };
        return { handled: true, message: task.resultSummary ?? "暂无详细结果" };
      }

      case JarvisActionId.CONTINUE_CHAT: {
        return { handled: true, message: "请继续发送消息" };
      }

      default:
        return { handled: false, message: `未知动作: ${params.actionId}` };
    }
  }

  /**
   * 启动自动刷新
   */
  startAutoRefresh(intervalMs?: number): void {
    const interval = intervalMs ?? this.config.autoRefreshIntervalMs;
    if (interval <= 0 || this.autoRefreshTimer) return;

    this.autoRefreshTimer = setInterval(() => {
      void this.refresh();
    }, interval);
    this.logger?.debug(`[JarvisCard] Auto refresh started: ${interval}ms`);
  }

  /**
   * 停止自动刷新
   */
  stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
      this.logger?.debug("[JarvisCard] Auto refresh stopped");
    }
  }

  /**
   * 获取卡片实例 ID
   */
  getCardInstanceId(): string | null {
    return this.cardInstance?.cardInstanceId ?? null;
  }

  /**
   * 获取任务列表
   */
  getTasks(): TaskLineData[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 获取指定任务
   */
  getTask(taskId: string): TaskLineData | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取任务数量
   */
  getTaskCount(): number {
    return this.tasks.size;
  }

  /**
   * 是否已完成
   */
  isCardFinished(): boolean {
    return this.isFinished;
  }

  /**
   * 获取会话信息
   */
  getConversationInfo(): {
    conversationType: "1" | "2";
    conversationId: string;
    senderId?: string;
  } {
    return {
      conversationType: this.conversationType,
      conversationId: this.conversationId,
      senderId: this.senderId,
    };
  }

  /**
   * 获取卡片创建时间戳
   */
  getStartedAt(): number {
    return this.cardStartedAt;
  }

  /**
   * 构建卡片渲染数据
   */
  private buildCardData(): JarvisCardData {
    return {
      title: this.config.title,
      tasks: Array.from(this.tasks.values()),
      isFinished: this.isFinished,
      startedAt: this.cardStartedAt,
    };
  }

  /**
   * 追加任务到活跃卡片
   *
   * 当用户在卡片运行期间发送新消息且被识别为"追加任务"时调用。
   * 新任务会添加到现有任务列表末尾，卡片立即刷新显示。
   */
  async appendTask(params: AddTaskParams): Promise<string> {
    if (this.isFinished) {
      this.logger?.warn("[JarvisCard] Cannot append task to finished card, reopening");
      this.isFinished = false;
    }

    this.addTask(params);
    await this.refresh(true);
    this.logger?.debug(`[JarvisCard] Task appended: ${params.taskId} - ${params.description}`);
    return params.taskId;
  }

  /**
   * 暂停所有排队中的任务
   *
   * 将所有 pending 状态的任务标记为 cancelled，
   * 但不影响正在运行的任务（running 状态的任务会继续执行到完成）。
   * 返回被暂停的任务数量。
   */
  pausePendingTasks(): number {
    let pausedCount = 0;
    for (const [taskId, task] of this.tasks) {
      if (task.status === "pending") {
        this.cancelTask(taskId);
        pausedCount++;
      }
    }
    this.logger?.debug(`[JarvisCard] Paused ${pausedCount} pending tasks`);
    return pausedCount;
  }

  /**
   * 获取当前运行中的任务数量
   */
  getRunningTaskCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") count++;
    }
    return count;
  }

  /**
   * 获取当前排队中的任务数量
   */
  getPendingTaskCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "pending") count++;
    }
    return count;
  }

  /**
   * 检查卡片是否有活跃任务（running 或 pending）
   */
  hasActiveTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.status === "pending") return true;
    }
    return false;
  }

  /**
   * 销毁卡片
   */
  destroy(): void {
    this.stopAutoRefresh();
    this.tasks.clear();
    this.taskStartTimes.clear();
    this.cardInstance = null;
    this.isFinished = false;
    this.lastRenderedContent = "";
    this.lastRefreshTime = 0;
    this.pendingRefresh = false;
    this.pendingRefreshForce = false;
  }
}

/**
 * 活跃卡片注册表
 *
 * 按 conversationId 索引，用于回调路由和上下文关联。
 * 每个会话同一时间只有一张活跃的 Jarvis 卡片。
 */
const activeCards = new Map<string, JarvisCard>();

/**
 * 注册活跃卡片
 */
export function registerActiveCard(conversationId: string, card: JarvisCard): void {
  // 销毁旧卡片
  const existing = activeCards.get(conversationId);
  if (existing && existing !== card) {
    existing.destroy();
  }
  activeCards.set(conversationId, card);
}

/**
 * 获取活跃卡片
 */
export function getActiveCard(conversationId: string): JarvisCard | undefined {
  return activeCards.get(conversationId);
}

/**
 * 通过卡片实例 ID 查找活跃卡片
 */
export function getActiveCardByInstanceId(cardInstanceId: string): JarvisCard | undefined {
  for (const card of activeCards.values()) {
    if (card.getCardInstanceId() === cardInstanceId) return card;
  }
  return undefined;
}

/**
 * 移除活跃卡片
 */
export function removeActiveCard(conversationId: string): void {
  const card = activeCards.get(conversationId);
  if (card) {
    card.destroy();
    activeCards.delete(conversationId);
  }
}

/**
 * 获取所有活跃卡片数量
 */
export function getActiveCardCount(): number {
  return activeCards.size;
}
