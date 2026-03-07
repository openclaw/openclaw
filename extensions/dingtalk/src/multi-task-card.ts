/**
 * 多任务卡片管理器
 *
 * 提供贾维斯式交互的多任务实时进度展示
 * 功能：
 * - 创建多任务进度卡片
 * - 实时更新单个任务进度
 * - 批量更新任务状态
 * - 任务完成/失败状态展示
 */

import type { AsyncTask, TaskStatus } from "./async-task-queue.js";
import { createAICard, streamAICard, finishAICard, type AICardInstance } from "./card.js";
import type { SubTask } from "./multi-task-parser.js";
import type { Logger } from "./shared/index.js";
import type { DingtalkConfig } from "./types.js";

/**
 * 任务进度信息
 */
export interface TaskProgress {
  /** 任务ID */
  taskId: string;
  /** 子任务ID（如果是多任务解析产生的） */
  subTaskId?: string;
  /** 任务描述 */
  description: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 进度百分比 (0-100) */
  progress: number;
  /** 任务类型 */
  type: string;
  /** 开始时间 */
  startedAt?: Date;
  /** 完成时间 */
  completedAt?: Date;
  /** 错误信息 */
  error?: string;
  /** 结果摘要 */
  result?: string;
}

/**
 * 多任务卡片配置
 */
export interface MultiTaskCardConfig {
  /** 是否显示任务ID */
  showTaskIds: boolean;
  /** 是否显示进度条 */
  showProgressBar: boolean;
  /** 是否显示预计时间 */
  showEstimatedTime: boolean;
  /** 自动刷新间隔（毫秒，0表示不自动刷新） */
  autoRefreshInterval: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: MultiTaskCardConfig = {
  showTaskIds: true,
  showProgressBar: true,
  showEstimatedTime: true,
  autoRefreshInterval: 0,
};

/**
 * 状态图标映射
 */
const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: "⏳",
  running: "🔄",
  completed: "✅",
  failed: "❌",
  cancelled: "🚫",
};

/**
 * 状态颜色映射（用于Markdown样式）
 */
const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: "#909399",
  running: "#409EFF",
  completed: "#67C23A",
  failed: "#F56C6C",
  cancelled: "#909399",
};

/**
 * 多任务卡片管理器
 */
export class MultiTaskCardManager {
  private cardInstance: AICardInstance | null = null;
  private tasks: Map<string, TaskProgress> = new Map();
  private config: MultiTaskCardConfig;
  private logger?: Logger;
  private updateTimer?: NodeJS.Timeout;
  private lastContent: string = "";
  private isFinished: boolean = false;

  constructor(config?: Partial<MultiTaskCardConfig>, logger?: Logger) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.logger = logger;
  }

  /**
   * 创建多任务卡片
   * @param params 创建参数
   * @returns 是否创建成功
   */
  async createCard(params: {
    cfg: DingtalkConfig;
    conversationType: "1" | "2";
    conversationId: string;
    senderId?: string;
    title?: string;
    initialTasks?: TaskProgress[];
  }): Promise<boolean> {
    const { cfg, conversationType, conversationId, senderId, title, initialTasks } = params;

    if (this.cardInstance) {
      this.logger?.debug("[MultiTaskCard] Card already exists, reusing");
      return true;
    }

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
        this.logger?.error("[MultiTaskCard] Failed to create card");
        return false;
      }

      // 初始化任务
      if (initialTasks) {
        for (const task of initialTasks) {
          this.tasks.set(task.taskId, task);
        }
      }

      // 发送初始内容
      const content = this.generateCardContent(title);
      await streamAICard(this.cardInstance, content, false, (msg) => this.logger?.debug(msg));
      this.lastContent = content;

      this.logger?.debug(`[MultiTaskCard] Card created with ${this.tasks.size} tasks`);
      return true;
    } catch (error) {
      this.logger?.error(`[MultiTaskCard] Error creating card: ${error}`);
      return false;
    }
  }

  /**
   * 添加任务到卡片
   * @param task 任务进度信息
   */
  addTask(task: TaskProgress): void {
    if (this.isFinished) {
      this.logger?.warn("[MultiTaskCard] Cannot add task to finished card");
      return;
    }

    this.tasks.set(task.taskId, task);
    this.logger?.debug(`[MultiTaskCard] Task added: ${task.taskId}`);
  }

  /**
   * 更新任务进度
   * @param taskId 任务ID
   * @param updates 更新内容
   */
  updateTask(taskId: string, updates: Partial<Omit<TaskProgress, "taskId">>): void {
    if (this.isFinished) {
      this.logger?.warn("[MultiTaskCard] Cannot update finished card");
      return;
    }

    const task = this.tasks.get(taskId);
    if (!task) {
      this.logger?.warn(`[MultiTaskCard] Task not found: ${taskId}`);
      return;
    }

    Object.assign(task, updates);
    this.logger?.debug(`[MultiTaskCard] Task updated: ${taskId} - ${updates.status || "progress"}`);
  }

  /**
   * 批量更新任务
   * @param updates 任务更新列表
   */
  updateTasks(updates: Array<{ taskId: string } & Partial<Omit<TaskProgress, "taskId">>>): void {
    for (const update of updates) {
      const { taskId, ...rest } = update;
      this.updateTask(taskId, rest);
    }
  }

  /**
   * 刷新卡片显示
   * @param title 卡片标题
   */
  async refresh(title?: string): Promise<void> {
    if (!this.cardInstance || this.isFinished) {
      return;
    }

    try {
      const content = this.generateCardContent(title);

      // 只有当内容变化时才更新
      if (content !== this.lastContent) {
        await streamAICard(this.cardInstance, content, false, (msg) => this.logger?.debug(msg));
        this.lastContent = content;
        this.logger?.debug("[MultiTaskCard] Card refreshed");
      }
    } catch (error) {
      this.logger?.error(`[MultiTaskCard] Error refreshing card: ${error}`);
    }
  }

  /**
   * 完成任务并显示最终结果
   * @param title 卡片标题
   * @param summary 结果摘要
   */
  async finish(title?: string, summary?: string): Promise<void> {
    if (!this.cardInstance || this.isFinished) {
      return;
    }

    try {
      this.isFinished = true;
      this.clearAutoRefresh();

      const content = summary || this.generateCardContent(title, true);
      await finishAICard(this.cardInstance, content, (msg) => this.logger?.debug(msg));

      this.logger?.debug("[MultiTaskCard] Card finished");
    } catch (error) {
      this.logger?.error(`[MultiTaskCard] Error finishing card: ${error}`);
    }
  }

  /**
   * 生成卡片内容
   * @param title 标题
   * @param isFinal 是否是最终状态
   * @returns 格式化的Markdown内容
   */
  private generateCardContent(title?: string, isFinal: boolean = false): string {
    const lines: string[] = [];

    // 标题
    if (title) {
      lines.push(`### ${title}`);
      lines.push("");
    }

    // 统计信息
    const stats = this.calculateStats();
    lines.push(this.formatStats(stats));
    lines.push("");

    // 任务列表
    if (this.tasks.size > 0) {
      lines.push("**任务进度：**");
      lines.push("");

      // 按状态分组排序：运行中 > 排队中 > 已完成 > 失败 > 已取消
      const sortedTasks = this.sortTasksByPriority();

      for (const task of sortedTasks) {
        lines.push(this.formatTaskLine(task));
      }

      lines.push("");
    }

    // 底部提示
    if (!isFinal) {
      if (stats.running > 0) {
        lines.push("---");
        lines.push("💡 您可以继续发送消息，我会实时更新任务进度");
      } else if (stats.pending > 0) {
        lines.push("---");
        lines.push("⏳ 任务正在排队中，请稍候...");
      }
    }

    return lines.join("\n");
  }

  /**
   * 计算任务统计
   */
  private calculateStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const stats = {
      total: this.tasks.size,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const task of this.tasks.values()) {
      stats[task.status]++;
    }

    return stats;
  }

  /**
   * 格式化统计信息
   */
  private formatStats(stats: ReturnType<typeof this.calculateStats>): string {
    const parts: string[] = [];

    if (stats.running > 0) {
      parts.push(`🔄 ${stats.running}个进行中`);
    }
    if (stats.pending > 0) {
      parts.push(`⏳ ${stats.pending}个排队`);
    }
    if (stats.completed > 0) {
      parts.push(`✅ ${stats.completed}个完成`);
    }
    if (stats.failed > 0) {
      parts.push(`❌ ${stats.failed}个失败`);
    }
    if (stats.cancelled > 0) {
      parts.push(`🚫 ${stats.cancelled}个取消`);
    }

    if (parts.length === 0) {
      return "📋 准备就绪";
    }

    return parts.join(" | ");
  }

  /**
   * 按优先级排序任务
   */
  private sortTasksByPriority(): TaskProgress[] {
    const priority: Record<TaskStatus, number> = {
      running: 1,
      pending: 2,
      completed: 3,
      failed: 4,
      cancelled: 5,
    };

    return Array.from(this.tasks.values()).sort((a, b) => priority[a.status] - priority[b.status]);
  }

  /**
   * 格式化单行任务
   */
  private formatTaskLine(task: TaskProgress): string {
    const icon = STATUS_ICONS[task.status];
    const idStr = this.config.showTaskIds ? ` \`#${task.taskId.slice(-6)}\`` : "";

    let line = `${icon}${idStr} ${task.description}`;

    // 添加进度条
    if (this.config.showProgressBar && task.status === "running") {
      line += ` ${this.renderProgressBar(task.progress)}`;
    }

    // 添加状态标签
    if (task.status === "completed" && task.result) {
      line += ` - ${task.result}`;
    } else if (task.status === "failed" && task.error) {
      line += ` - ${task.error.slice(0, 30)}${task.error.length > 30 ? "..." : ""}`;
    }

    return line;
  }

  /**
   * 渲染进度条
   */
  private renderProgressBar(progress: number): string {
    const filled = Math.round(progress / 10);
    const empty = 10 - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    return `[${bar}] ${progress}%`;
  }

  /**
   * 设置自动刷新
   * @param interval 刷新间隔（毫秒）
   */
  startAutoRefresh(interval?: number): void {
    const refreshInterval = interval || this.config.autoRefreshInterval;
    if (refreshInterval <= 0 || this.updateTimer) {
      return;
    }

    this.updateTimer = setInterval(() => {
      this.refresh();
    }, refreshInterval);

    this.logger?.debug(`[MultiTaskCard] Auto refresh started: ${refreshInterval}ms`);
  }

  /**
   * 停止自动刷新
   */
  stopAutoRefresh(): void {
    this.clearAutoRefresh();
  }

  /**
   * 清除自动刷新定时器
   */
  private clearAutoRefresh(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
      this.logger?.debug("[MultiTaskCard] Auto refresh stopped");
    }
  }

  /**
   * 获取任务信息
   */
  getTask(taskId: string): TaskProgress | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): TaskProgress[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 检查是否已完成
   */
  isCardFinished(): boolean {
    return this.isFinished;
  }

  /**
   * 销毁卡片管理器
   */
  destroy(): void {
    this.clearAutoRefresh();
    this.tasks.clear();
    this.cardInstance = null;
    this.isFinished = false;
    this.lastContent = "";
  }
}

/**
 * 从SubTask创建任务进度
 */
export function createTaskProgressFromSubTask(subTask: SubTask, taskId: string): TaskProgress {
  return {
    taskId,
    subTaskId: subTask.id,
    description: subTask.description,
    status: "pending",
    progress: 0,
    type: subTask.type,
  };
}

/**
 * 从AsyncTask创建任务进度
 */
export function createTaskProgressFromAsyncTask(task: AsyncTask): TaskProgress {
  return {
    taskId: task.id,
    description: task.description,
    status: task.status,
    progress: task.status === "completed" ? 100 : task.status === "running" ? 50 : 0,
    type: task.type,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    error: task.error,
  };
}

/**
 * 全局卡片管理器映射
 */
const globalCardManagers: Map<string, MultiTaskCardManager> = new Map();

/**
 * 获取或创建会话的卡片管理器
 */
export function getOrCreateCardManager(
  sessionId: string,
  config?: Partial<MultiTaskCardConfig>,
  logger?: Logger,
): MultiTaskCardManager {
  let manager = globalCardManagers.get(sessionId);
  if (!manager || manager.isCardFinished()) {
    manager = new MultiTaskCardManager(config, logger);
    globalCardManagers.set(sessionId, manager);
  }
  return manager;
}

/**
 * 获取会话的卡片管理器（如果不存在返回null）
 */
export function getCardManager(sessionId: string): MultiTaskCardManager | null {
  const manager = globalCardManagers.get(sessionId);
  if (manager && !manager.isCardFinished()) {
    return manager;
  }
  return null;
}

/**
 * 销毁会话的卡片管理器
 */
export function destroyCardManager(sessionId: string): void {
  const manager = globalCardManagers.get(sessionId);
  if (manager) {
    manager.destroy();
    globalCardManagers.delete(sessionId);
  }
}

/**
 * 清理所有已完成的卡片管理器
 */
export function cleanupFinishedCardManagers(): number {
  let count = 0;
  for (const [sessionId, manager] of globalCardManagers) {
    if (manager.isCardFinished()) {
      manager.destroy();
      globalCardManagers.delete(sessionId);
      count++;
    }
  }
  return count;
}
