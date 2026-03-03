/**
 * 任务通知器
 *
 * 负责异步任务状态的通知推送
 * 包括：任务提交确认、完成通知、失败通知、取消确认、状态查询响应
 */

import type { AsyncTask, TaskStatus } from "./async-task-queue.js";
import { createAICard, finishAICard } from "./card.js";
import type { DingtalkConfig } from "./config.js";
import { sendMessageDingtalk } from "./send.js";
import type { Logger } from "./shared/index.js";

/**
 * 通知器配置
 */
export interface TaskNotifierConfig {
  /** 是否启用通知 */
  enabled: boolean;
  /** 任务完成时是否 @ 用户 */
  mentionOnComplete: boolean;
  /** 任务失败时是否 @ 用户 */
  mentionOnError: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: TaskNotifierConfig = {
  enabled: true,
  mentionOnComplete: true,
  mentionOnError: true,
};

/**
 * 任务状态图标映射
 */
const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: "⏳",
  running: "🔄",
  completed: "✅",
  failed: "❌",
  cancelled: "🚫",
};

/**
 * 任务状态文本映射
 */
const STATUS_TEXT: Record<TaskStatus, string> = {
  pending: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/**
 * 任务通知器
 */
export class TaskNotifier {
  private config: TaskNotifierConfig;
  private logger?: Logger;

  constructor(config?: Partial<TaskNotifierConfig>, logger?: Logger) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.logger = logger;
  }

  /**
   * 发送任务提交确认消息（使用 AI Card）
   * @param params 任务参数
   */
  async notifyTaskSubmitted(params: {
    cfg: DingtalkConfig;
    task: AsyncTask;
    chatType: "direct" | "group";
    queuePosition?: number;
    senderId?: string;
  }): Promise<void> {
    const { cfg, task, chatType, queuePosition, senderId } = params;

    if (!this.config.enabled) {
      return;
    }

    const queueInfo =
      queuePosition && queuePosition > 0 ? `\n当前队列: ${queuePosition}个任务排队中` : "";

    const message = `📋 **任务已启动**

${task.description}

任务ID: \`#${task.id}\`${queueInfo}

处理完成后将通知您，请耐心等待...`;

    try {
      // 使用 AI Card 显示任务已启动，并立即结束卡片
      const card = await createAICard({
        cfg,
        conversationType: chatType === "group" ? "2" : "1",
        conversationId: task.conversationId,
        senderId,
        senderStaffId: senderId,
        log: (msg) => this.logger?.debug(msg),
      });

      if (card) {
        // 立即结束 AI Card，显示"任务已启动"
        try {
          await finishAICard(card, message, (msg) => this.logger?.debug(msg));
          this.logger?.debug(
            `[TaskNotifier] Task submitted notification sent via AI Card: ${task.id}`,
          );
        } catch (cardErr) {
          // Retry once to avoid mixing card + plain message formats
          this.logger?.warn(
            `[TaskNotifier] AI Card finish failed (attempt 1/2), retrying: ${String(cardErr)}`,
          );
          try {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await finishAICard(card, message, (msg) => this.logger?.debug(msg));
            this.logger?.debug(
              `[TaskNotifier] Task submitted notification sent via AI Card on retry: ${task.id}`,
            );
          } catch (retryErr) {
            this.logger?.warn(
              `[TaskNotifier] AI Card finish failed after 2 attempts, skipping: ${String(retryErr)}`,
            );
          }
        }
      } else {
        // AI Card creation returned null — send plain message as last resort
        await sendMessageDingtalk({
          cfg,
          to: task.conversationId,
          text: message,
          chatType,
          title: "任务已启动",
        });
        this.logger?.debug(`[TaskNotifier] Task submitted notification sent via text: ${task.id}`);
      }
    } catch (error) {
      this.logger?.error(
        `[TaskNotifier] Failed to send task submitted notification: ${task.id}, error: ${error}`,
      );
    }
  }

  /**
   * 发送任务完成通知
   * @param params 任务参数
   */
  async notifyTaskCompleted(params: {
    cfg: DingtalkConfig;
    task: AsyncTask;
    chatType: "direct" | "group";
    result?: string;
  }): Promise<void> {
    const { cfg, task, chatType, result } = params;

    if (!this.config.enabled) {
      return;
    }

    const mention = this.config.mentionOnComplete && task.userId ? `@${task.userId} ` : "";
    const resultText = result ? `\n\n**处理结果：**\n${result}` : "";

    const message = `${mention}✅ **任务已完成**

任务ID: \`#${task.id}\`
任务: ${task.description}${resultText}`;

    try {
      await sendMessageDingtalk({
        cfg,
        to: task.conversationId,
        text: message,
        chatType,
        title: "任务完成",
      });
      this.logger?.debug(`[TaskNotifier] Task completed notification sent: ${task.id}`);
    } catch (error) {
      this.logger?.error(
        `[TaskNotifier] Failed to send task completed notification: ${task.id}, error: ${error}`,
      );
    }
  }

  /**
   * 发送任务失败通知
   * @param params 任务参数
   */
  async notifyTaskFailed(params: {
    cfg: DingtalkConfig;
    task: AsyncTask;
    chatType: "direct" | "group";
    error?: string;
  }): Promise<void> {
    const { cfg, task, chatType, error } = params;

    if (!this.config.enabled) {
      return;
    }

    const mention = this.config.mentionOnError && task.userId ? `@${task.userId} ` : "";
    const errorText = error || task.error || "未知错误";

    const message = `${mention}❌ **任务执行失败**

任务ID: \`#${task.id}\`
任务: ${task.description}

**错误信息：**
\`\`\`
${errorText}
\`\`\`

请稍后重试或联系管理员。`;

    try {
      await sendMessageDingtalk({
        cfg,
        to: task.conversationId,
        text: message,
        chatType,
        title: "任务失败",
      });
      this.logger?.debug(`[TaskNotifier] Task failed notification sent: ${task.id}`);
    } catch (sendError) {
      this.logger?.error(
        `[TaskNotifier] Failed to send task failed notification: ${task.id}, error: ${sendError}`,
      );
    }
  }

  /**
   * 发送任务取消确认
   * @param params 任务参数
   */
  async notifyTaskCancelled(params: {
    cfg: DingtalkConfig;
    task: AsyncTask;
    chatType: "direct" | "group";
  }): Promise<void> {
    const { cfg, task, chatType } = params;

    if (!this.config.enabled) {
      return;
    }

    const message = `🚫 **任务已取消**

任务ID: \`#${task.id}\`
任务: ${task.description}`;

    try {
      await sendMessageDingtalk({
        cfg,
        to: task.conversationId,
        text: message,
        chatType,
        title: "任务取消",
      });
      this.logger?.debug(`[TaskNotifier] Task cancelled notification sent: ${task.id}`);
    } catch (error) {
      this.logger?.error(
        `[TaskNotifier] Failed to send task cancelled notification: ${task.id}, error: ${error}`,
      );
    }
  }

  /**
   * 生成任务状态列表消息
   * @param tasks 任务列表
   * @returns 格式化的状态消息
   */
  generateTaskStatusMessage(tasks: AsyncTask[]): string {
    if (tasks.length === 0) {
      return "📋 **您的任务状态**\n\n当前没有进行中的任务。";
    }

    // 按状态分组
    const running = tasks.filter((t) => t.status === "running");
    const pending = tasks.filter((t) => t.status === "pending");
    const completed = tasks.filter((t) => t.status === "completed");
    const failed = tasks.filter((t) => t.status === "failed");
    const cancelled = tasks.filter((t) => t.status === "cancelled");

    const lines: string[] = ["📋 **您的任务状态**\n"];

    // 运行中任务
    if (running.length > 0) {
      lines.push("**🔄 运行中：**");
      for (const task of running) {
        const duration = this.formatDuration(task.startedAt);
        lines.push(`• \`#${task.id}\` ${task.description} [${duration}]`);
      }
      lines.push("");
    }

    // 排队中任务
    if (pending.length > 0) {
      lines.push("**⏳ 排队中：**");
      for (const task of pending) {
        const waitTime = this.formatDuration(task.createdAt);
        lines.push(`• \`#${task.id}\` ${task.description} [等待${waitTime}]`);
      }
      lines.push("");
    }

    // 已完成任务（只显示最近5个）
    const recentCompleted = completed.slice(0, 5);
    if (recentCompleted.length > 0) {
      lines.push("**✅ 已完成：**");
      for (const task of recentCompleted) {
        lines.push(`• \`#${task.id}\` ${task.description}`);
      }
      if (completed.length > 5) {
        lines.push(`... 还有 ${completed.length - 5} 个已完成任务`);
      }
      lines.push("");
    }

    // 失败任务
    if (failed.length > 0) {
      lines.push("**❌ 失败：**");
      for (const task of failed) {
        lines.push(`• \`#${task.id}\` ${task.description}`);
      }
      lines.push("");
    }

    // 已取消任务
    if (cancelled.length > 0) {
      lines.push("**🚫 已取消：**");
      for (const task of cancelled.slice(0, 3)) {
        lines.push(`• \`#${task.id}\` ${task.description}`);
      }
      if (cancelled.length > 3) {
        lines.push(`... 还有 ${cancelled.length - 3} 个已取消任务`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 发送任务状态查询响应
   * @param params 查询参数
   */
  async sendTaskStatusResponse(params: {
    cfg: DingtalkConfig;
    tasks: AsyncTask[];
    conversationId: string;
    chatType: "direct" | "group";
  }): Promise<void> {
    const { cfg, tasks, conversationId, chatType } = params;

    if (!this.config.enabled) {
      return;
    }

    const message = this.generateTaskStatusMessage(tasks);

    try {
      await sendMessageDingtalk({
        cfg,
        to: conversationId,
        text: message,
        chatType,
        title: "任务状态",
      });
      this.logger?.debug(`[TaskNotifier] Task status response sent, tasks: ${tasks.length}`);
    } catch (error) {
      this.logger?.error(`[TaskNotifier] Failed to send task status response, error: ${error}`);
    }
  }

  /**
   * 生成批量取消确认消息
   * @param count 取消的任务数
   * @returns 格式化的消息
   */
  generateBatchCancelMessage(count: number): string {
    if (count === 0) {
      return "🚫 没有找到可以取消的任务。";
    }
    return `✅ 已取消 **${count}** 个任务。`;
  }

  /**
   * 发送批量取消确认
   * @param params 取消参数
   */
  async sendBatchCancelConfirmation(params: {
    cfg: DingtalkConfig;
    count: number;
    conversationId: string;
    chatType: "direct" | "group";
  }): Promise<void> {
    const { cfg, count, conversationId, chatType } = params;

    if (!this.config.enabled) {
      return;
    }

    const message = this.generateBatchCancelMessage(count);

    try {
      await sendMessageDingtalk({
        cfg,
        to: conversationId,
        text: message,
        chatType,
        title: "批量取消任务",
      });
      this.logger?.debug(`[TaskNotifier] Batch cancel confirmation sent, count: ${count}`);
    } catch (error) {
      this.logger?.error(
        `[TaskNotifier] Failed to send batch cancel confirmation, error: ${error}`,
      );
    }
  }

  /**
   * 格式化持续时间
   * @param startTime 开始时间
   * @returns 格式化后的时间字符串
   */
  private formatDuration(startTime?: Date): string {
    if (!startTime) {
      return "未知";
    }

    const now = new Date();
    const diff = Math.floor((now.getTime() - startTime.getTime()) / 1000);

    if (diff < 60) {
      return `${diff}秒`;
    } else if (diff < 3600) {
      return `${Math.floor(diff / 60)}分钟`;
    } else {
      return `${Math.floor(diff / 3600)}小时${Math.floor((diff % 3600) / 60)}分钟`;
    }
  }

  /**
   * 发送多任务启动通知
   * @param params 通知参数
   */
  async notifyMultiTaskStarted(params: {
    cfg: DingtalkConfig;
    tasks: AsyncTask[];
    chatType: "direct" | "group";
    conversationId: string;
    senderId?: string;
  }): Promise<void> {
    const { cfg, tasks, chatType, conversationId, senderId } = params;

    if (!this.config.enabled || tasks.length === 0) {
      return;
    }

    const taskList = tasks.map((t, i) => `${i + 1}. ${t.description}`).join("\n");
    const message = `📋 **已启动 ${tasks.length} 个任务**

${taskList}

所有任务将并行处理，我会实时更新进度。`;

    try {
      // 使用 AI Card 显示多任务启动
      const card = await createAICard({
        cfg,
        conversationType: chatType === "group" ? "2" : "1",
        conversationId,
        senderId,
        senderStaffId: senderId,
        log: (msg) => this.logger?.debug(msg),
      });

      if (card) {
        try {
          await finishAICard(card, message, (msg) => this.logger?.debug(msg));
          this.logger?.debug(
            `[TaskNotifier] Multi-task started notification sent: ${tasks.length} tasks`,
          );
        } catch (cardErr) {
          this.logger?.warn(
            `[TaskNotifier] AI Card finish failed (attempt 1/2), retrying: ${String(cardErr)}`,
          );
          try {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await finishAICard(card, message, (msg) => this.logger?.debug(msg));
            this.logger?.debug(
              `[TaskNotifier] Multi-task started notification sent on retry: ${tasks.length} tasks`,
            );
          } catch (retryErr) {
            this.logger?.warn(
              `[TaskNotifier] AI Card finish failed after 2 attempts, skipping: ${String(retryErr)}`,
            );
          }
        }
      } else {
        // AI Card creation returned null — send plain message as last resort
        await sendMessageDingtalk({
          cfg,
          to: conversationId,
          text: message,
          chatType,
          title: "多任务启动",
        });
      }
    } catch (error) {
      this.logger?.error(`[TaskNotifier] Failed to send multi-task started notification: ${error}`);
    }
  }

  /**
   * 发送多任务完成汇总通知
   * @param params 通知参数
   */
  async notifyMultiTaskCompleted(params: {
    cfg: DingtalkConfig;
    summary: MultiTaskSummary;
    chatType: "direct" | "group";
    conversationId: string;
    userId?: string;
  }): Promise<void> {
    const { cfg, summary, chatType, conversationId, userId } = params;

    if (!this.config.enabled) {
      return;
    }

    const mention = this.config.mentionOnComplete && userId ? `@${userId} ` : "";
    const lines: string[] = [`${mention}✅ **所有任务处理完成**`, ""];

    // 统计概览
    lines.push(`📊 **执行概览**`);
    lines.push(`• 总任务数: ${summary.total}`);
    lines.push(`• ✅ 成功: ${summary.completed}`);
    lines.push(`• ❌ 失败: ${summary.failed}`);
    lines.push(`• 🔄 进行中: ${summary.running}`);
    lines.push(`• ⏳ 排队: ${summary.pending}`);
    lines.push(`• 🚫 取消: ${summary.cancelled}`);

    if (summary.totalDuration) {
      lines.push(
        `• ⏱️ 总耗时: ${this.formatDuration(new Date(Date.now() - summary.totalDuration))}`,
      );
    }

    // 完成的任务详情
    if (summary.completedTasks.length > 0) {
      lines.push("");
      lines.push("**✅ 完成的任务：**");
      for (const task of summary.completedTasks.slice(0, 5)) {
        const resultPreview = task.result
          ? ` - ${task.result.slice(0, 50)}${task.result.length > 50 ? "..." : ""}`
          : "";
        lines.push(`• \`#${task.id.slice(-6)}\` ${task.description}${resultPreview}`);
      }
      if (summary.completedTasks.length > 5) {
        lines.push(`... 还有 ${summary.completedTasks.length - 5} 个完成的任务`);
      }
    }

    // 失败的任务详情
    if (summary.failedTasks.length > 0) {
      lines.push("");
      lines.push("**❌ 失败的任务：**");
      for (const task of summary.failedTasks.slice(0, 3)) {
        const errorPreview = task.error
          ? ` - ${task.error.slice(0, 30)}${task.error.length > 30 ? "..." : ""}`
          : "";
        lines.push(`• \`#${task.id.slice(-6)}\` ${task.description}${errorPreview}`);
      }
      if (summary.failedTasks.length > 3) {
        lines.push(`... 还有 ${summary.failedTasks.length - 3} 个失败的任务`);
      }
    }

    const message = lines.join("\n");

    try {
      await sendMessageDingtalk({
        cfg,
        to: conversationId,
        text: message,
        chatType,
        title: "任务完成汇总",
      });
      this.logger?.debug(`[TaskNotifier] Multi-task completed notification sent`);
    } catch (error) {
      this.logger?.error(
        `[TaskNotifier] Failed to send multi-task completed notification: ${error}`,
      );
    }
  }

  /**
   * 发送单个任务进度更新通知（用于主动推送）
   * @param params 通知参数
   */
  async notifyTaskProgressUpdate(params: {
    cfg: DingtalkConfig;
    update: MultiTaskProgressUpdate;
    chatType: "direct" | "group";
    conversationId: string;
  }): Promise<void> {
    const { cfg, update, chatType, conversationId } = params;

    if (!this.config.enabled) {
      return;
    }

    const icon = STATUS_ICONS[update.status];
    const progressBar =
      update.status === "running"
        ? ` [${"█".repeat(Math.round(update.progress / 10))}${"░".repeat(10 - Math.round(update.progress / 10))}] ${update.progress}%`
        : "";

    const message = `${icon} **任务进度更新**

\`#${update.taskId.slice(-6)}\` ${update.description}${progressBar}`;

    try {
      await sendMessageDingtalk({
        cfg,
        to: conversationId,
        text: message,
        chatType,
        title: "任务进度",
      });
      this.logger?.debug(`[TaskNotifier] Task progress update sent: ${update.taskId}`);
    } catch (error) {
      this.logger?.error(`[TaskNotifier] Failed to send progress update: ${error}`);
    }
  }

  /**
   * 发送任务中断通知
   * @param params 通知参数
   */
  async notifyTaskInterrupted(params: {
    cfg: DingtalkConfig;
    task: AsyncTask;
    chatType: "direct" | "group";
    reason: string;
  }): Promise<void> {
    const { cfg, task, chatType, reason } = params;

    if (!this.config.enabled) {
      return;
    }

    const message = `⚠️ **任务已中断**

任务ID: \`#${task.id}\`
任务: ${task.description}

**中断原因：** ${reason}

您可以：
• 发送"重试任务#${task.id.slice(-6)}"来重新执行
• 发送"查看任务状态"了解详情`;

    try {
      await sendMessageDingtalk({
        cfg,
        to: task.conversationId,
        text: message,
        chatType,
        title: "任务中断",
      });
      this.logger?.debug(`[TaskNotifier] Task interrupted notification sent: ${task.id}`);
    } catch (error) {
      this.logger?.error(`[TaskNotifier] Failed to send task interrupted notification: ${error}`);
    }
  }

  /**
   * 发送任务修正确认通知
   * @param params 通知参数
   */
  async notifyTaskCorrected(params: {
    cfg: DingtalkConfig;
    originalTask: AsyncTask;
    correctedTask: AsyncTask;
    chatType: "direct" | "group";
  }): Promise<void> {
    const { cfg, originalTask, correctedTask, chatType } = params;

    if (!this.config.enabled) {
      return;
    }

    const message = `📝 **任务已修正**

原任务: \`#${originalTask.id}\` ${originalTask.description}
新任务: \`#${correctedTask.id}\` ${correctedTask.description}

修正后的任务已重新加入队列处理。`;

    try {
      await sendMessageDingtalk({
        cfg,
        to: originalTask.conversationId,
        text: message,
        chatType,
        title: "任务修正",
      });
      this.logger?.debug(
        `[TaskNotifier] Task corrected notification sent: ${originalTask.id} -> ${correctedTask.id}`,
      );
    } catch (error) {
      this.logger?.error(`[TaskNotifier] Failed to send task corrected notification: ${error}`);
    }
  }

  /**
   * 发送任务超时预警通知
   *
   * 当任务运行时间接近超时限制时，主动通知用户。
   */
  async notifyTaskTimeoutWarning(params: {
    cfg: DingtalkConfig;
    taskId: string;
    description: string;
    elapsedMs: number;
    remainingSeconds: number;
    chatType: "direct" | "group";
    conversationId: string;
  }): Promise<void> {
    const { cfg, taskId, description, elapsedMs, remainingSeconds, chatType, conversationId } =
      params;

    if (!this.config.enabled) return;

    const elapsedMinutes = Math.round(elapsedMs / 60_000);
    const message = `⚠️ **任务运行时间较长**

\`#${taskId.slice(-6)}\` ${description}

已运行 **${elapsedMinutes} 分钟**，剩余约 ${remainingSeconds} 秒将超时。

如需继续等待，无需操作。如需取消，请发送"取消任务"。`;

    try {
      await sendMessageDingtalk({
        cfg,
        to: conversationId,
        text: message,
        chatType,
        title: "任务超时预警",
      });
      this.logger?.debug(`[TaskNotifier] Timeout warning sent for task: ${taskId}`);
    } catch (error) {
      this.logger?.error(`[TaskNotifier] Failed to send timeout warning: ${error}`);
    }
  }

  /**
   * 发送带解决建议的失败通知
   *
   * 相比普通的 notifyTaskFailed，此方法会根据错误信息
   * 自动生成可能的解决建议，并在连续失败时提醒用户调整策略。
   */
  async notifyFailureWithSuggestion(params: {
    cfg: DingtalkConfig;
    task: AsyncTask;
    chatType: "direct" | "group";
    error: string;
    consecutiveFailures: number;
  }): Promise<void> {
    const { cfg, task, chatType, error: errorMsg, consecutiveFailures } = params;

    if (!this.config.enabled) return;

    const suggestions = generateFailureSuggestions(errorMsg);
    const consecutiveWarning =
      consecutiveFailures >= 3
        ? `\n\n⚠️ 您已连续 ${consecutiveFailures} 次任务失败，建议：\n• 检查指令是否清晰明确\n• 尝试简化任务描述\n• 将复杂任务拆分为多个小任务`
        : "";

    const message = `❌ **任务执行失败**

任务: ${task.description}

**错误信息：** ${errorMsg.substring(0, 200)}

**💡 建议：**
${suggestions.map((suggestion) => `• ${suggestion}`).join("\n")}${consecutiveWarning}`;

    try {
      await sendMessageDingtalk({
        cfg,
        to: task.conversationId,
        text: message,
        chatType,
        title: "任务失败",
      });
      this.logger?.debug(`[TaskNotifier] Failure with suggestion sent for task: ${task.id}`);
    } catch (sendError) {
      this.logger?.error(`[TaskNotifier] Failed to send failure suggestion: ${sendError}`);
    }
  }
}

/**
 * 多任务状态汇总
 */
export interface MultiTaskSummary {
  /** 总任务数 */
  total: number;
  /** 已完成数 */
  completed: number;
  /** 失败数 */
  failed: number;
  /** 进行中数 */
  running: number;
  /** 排队中数 */
  pending: number;
  /** 已取消数 */
  cancelled: number;
  /** 总耗时（毫秒） */
  totalDuration?: number;
  /** 完成的任务列表 */
  completedTasks: Array<{
    id: string;
    description: string;
    result?: string;
  }>;
  /** 失败的任务列表 */
  failedTasks: Array<{
    id: string;
    description: string;
    error?: string;
  }>;
}

/**
 * 多任务进度更新
 */
export interface MultiTaskProgressUpdate {
  /** 任务ID */
  taskId: string;
  /** 任务描述 */
  description: string;
  /** 当前状态 */
  status: TaskStatus;
  /** 进度百分比 */
  progress: number;
  /** 结果/错误信息 */
  result?: string;
  error?: string;
}

/**
 * 长时间运行任务的进度追踪器
 *
 * 当任务运行超过指定阈值时，自动发送中间进度更新。
 * 支持超时预警和自动清理。
 */
export class TaskProgressTracker {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private taskStartTimes: Map<string, number> = new Map();
  private notifier: TaskNotifier;
  private logger?: Logger;

  /** 发送进度更新的间隔（毫秒），默认 30 秒 */
  private progressIntervalMs: number;
  /** 超时预警阈值（毫秒），默认 4 分钟（在 5 分钟超时前预警） */
  private timeoutWarningMs: number;
  /** 连续失败计数（按用户维度） */
  private consecutiveFailures: Map<string, number> = new Map();

  constructor(
    notifier: TaskNotifier,
    options?: {
      progressIntervalMs?: number;
      timeoutWarningMs?: number;
    },
    logger?: Logger,
  ) {
    this.notifier = notifier;
    this.progressIntervalMs = options?.progressIntervalMs ?? 30_000;
    this.timeoutWarningMs = options?.timeoutWarningMs ?? 4 * 60_000;
    this.logger = logger;
  }

  /**
   * 开始追踪任务进度
   *
   * 设置定时器，在任务运行超过 progressIntervalMs 后发送进度更新，
   * 并在接近超时时发送预警。
   */
  startTracking(params: {
    taskId: string;
    description: string;
    cfg: DingtalkConfig;
    conversationId: string;
    chatType: "direct" | "group";
  }): void {
    const { taskId, description, cfg, conversationId, chatType } = params;

    // 清理已有的追踪器（防止重复）
    this.stopTracking(taskId);

    const startTime = Date.now();
    this.taskStartTimes.set(taskId, startTime);
    let updateCount = 0;
    let timeoutWarningSent = false;

    const timer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      updateCount++;

      // 超时预警（接近 5 分钟超时限制）
      if (!timeoutWarningSent && elapsed >= this.timeoutWarningMs) {
        timeoutWarningSent = true;
        const remainingSeconds = Math.max(0, Math.round((5 * 60_000 - elapsed) / 1000));
        void this.notifier.notifyTaskTimeoutWarning({
          cfg,
          taskId,
          description,
          elapsedMs: elapsed,
          remainingSeconds,
          chatType,
          conversationId,
        });
        return;
      }

      // 常规进度更新（每 30 秒一次）
      const elapsedSeconds = Math.round(elapsed / 1000);
      this.logger?.debug(
        `[ProgressTracker] Task ${taskId} running for ${elapsedSeconds}s (update #${updateCount})`,
      );
    }, this.progressIntervalMs);

    this.timers.set(taskId, timer);
    this.logger?.debug(`[ProgressTracker] Started tracking task: ${taskId}`);
  }

  /**
   * 停止追踪任务进度
   */
  stopTracking(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(taskId);
      this.taskStartTimes.delete(taskId);
      this.logger?.debug(`[ProgressTracker] Stopped tracking task: ${taskId}`);
    }
  }

  /**
   * 记录任务失败并检查是否需要建议调整策略
   *
   * 当同一用户连续失败 3 次以上时，返回建议信息。
   */
  recordFailure(userId: string): { shouldSuggestAdjustment: boolean; consecutiveCount: number } {
    const currentCount = (this.consecutiveFailures.get(userId) ?? 0) + 1;
    this.consecutiveFailures.set(userId, currentCount);

    return {
      shouldSuggestAdjustment: currentCount >= 3,
      consecutiveCount: currentCount,
    };
  }

  /**
   * 重置用户的连续失败计数（任务成功时调用）
   */
  resetFailureCount(userId: string): void {
    this.consecutiveFailures.delete(userId);
  }

  /**
   * 获取任务已运行时间
   */
  getElapsedMs(taskId: string): number | null {
    const startTime = this.taskStartTimes.get(taskId);
    if (!startTime) return null;
    return Date.now() - startTime;
  }

  /**
   * 清理所有追踪器
   */
  cleanup(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.taskStartTimes.clear();
    this.consecutiveFailures.clear();
    this.logger?.debug("[ProgressTracker] All trackers cleaned up");
  }
}

/**
 * 根据错误信息生成可能的解决建议
 */
function generateFailureSuggestions(errorMessage: string): string[] {
  const suggestions: string[] = [];
  const lowerError = errorMessage.toLowerCase();

  if (lowerError.includes("timeout") || lowerError.includes("超时")) {
    suggestions.push("任务可能过于复杂，尝试简化或拆分任务");
    suggestions.push("网络可能不稳定，稍后重试");
  } else if (lowerError.includes("rate limit") || lowerError.includes("429")) {
    suggestions.push("请求频率过高，请等待几分钟后重试");
    suggestions.push("减少并发任务数量");
  } else if (
    lowerError.includes("auth") ||
    lowerError.includes("permission") ||
    lowerError.includes("权限")
  ) {
    suggestions.push("检查相关权限配置是否正确");
    suggestions.push("联系管理员确认账号权限");
  } else if (lowerError.includes("not found") || lowerError.includes("404")) {
    suggestions.push("检查引用的资源是否存在");
    suggestions.push("确认名称或路径是否正确");
  } else if (lowerError.includes("context") || lowerError.includes("token")) {
    suggestions.push("输入内容可能过长，尝试精简描述");
    suggestions.push("将长文本分段处理");
  } else {
    suggestions.push("稍后重试该任务");
    suggestions.push("尝试用不同的方式描述需求");
  }

  return suggestions;
}

/**
 * 创建任务通知器实例
 * @param config 配置
 * @param logger 日志记录器
 * @returns TaskNotifier 实例
 */
export function createTaskNotifier(
  config?: Partial<TaskNotifierConfig>,
  logger?: Logger,
): TaskNotifier {
  return new TaskNotifier(config, logger);
}
