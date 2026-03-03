/**
 * Jarvis 卡片按钮回调路由
 *
 * 处理钉钉互动卡片的按钮点击回调。
 * 当用户点击卡片上的按钮时，钉钉通过 Stream 回调将事件推送过来，
 * 本模块负责解析回调 payload、路由到对应的 JarvisCard 实例处理。
 *
 * 回调流程:
 * 1. 钉钉 Stream 推送卡片回调事件
 * 2. monitor.ts 识别为卡片回调，转发到本模块
 * 3. 解析 payload 中的 actionId 和 cardInstanceId
 * 4. 查找对应的 JarvisCard 实例
 * 5. 调用 JarvisCard.handleAction() 处理
 * 6. 返回处理结果
 */

import type { AsyncTaskQueue } from "./async-task-queue.js";
import { decodeActionParams, type JarvisActionParams } from "./jarvis-card-template.js";
import { getActiveCardByInstanceId } from "./jarvis-card.js";
import type { Logger } from "./shared/index.js";

/**
 * 卡片回调事件 payload
 *
 * 钉钉卡片回调的原始数据结构。
 * 当 callbackType 为 "STREAM" 时，回调通过 Stream 连接推送。
 */
export interface CardCallbackPayload {
  /** 卡片实例的 outTrackId */
  outTrackId: string;
  /** 触发用户的 userId */
  userId?: string;
  /** 触发用户的 staffId */
  staffId?: string;
  /** 按钮的 action 参数（JSON 字符串） */
  actionParams?: Record<string, string>;
  /** 按钮的 cardPrivateData（私有数据） */
  cardPrivateData?: Record<string, unknown>;
  /** 会话 ID */
  conversationId?: string;
}

/**
 * 回调处理结果
 */
export interface CallbackResult {
  /** 是否处理成功 */
  success: boolean;
  /** 处理消息 */
  message?: string;
  /** 是否需要重新入队任务（重试场景） */
  retryTaskId?: string;
}

/**
 * 回调处理器配置
 */
export interface CardCallbackHandlerConfig {
  /** 异步任务队列（用于取消/重试任务） */
  taskQueue?: AsyncTaskQueue;
  /** 日志记录器 */
  logger?: Logger;
}

/**
 * 处理卡片按钮回调
 *
 * 这是回调路由的核心入口。从 monitor.ts 的 Stream 事件处理中调用。
 *
 * @param payload 钉钉推送的回调 payload
 * @param config 处理器配置
 * @returns 处理结果
 */
export async function handleCardCallback(
  payload: CardCallbackPayload,
  config: CardCallbackHandlerConfig,
): Promise<CallbackResult> {
  const { logger, taskQueue } = config;

  logger?.debug(`[CardCallback] Received callback for card: ${payload.outTrackId}`);

  // 查找对应的 JarvisCard 实例
  const card = getActiveCardByInstanceId(payload.outTrackId);
  if (!card) {
    logger?.warn(`[CardCallback] No active card found for: ${payload.outTrackId}`);
    return { success: false, message: "卡片已过期或不存在" };
  }

  // 解析 action 参数
  const actionParams = extractActionParams(payload);
  if (!actionParams) {
    logger?.warn(`[CardCallback] Failed to parse action params from callback`);
    return { success: false, message: "无法解析按钮参数" };
  }

  // 补充用户信息
  actionParams.userId = payload.userId ?? payload.staffId;

  logger?.debug(
    `[CardCallback] Action: ${actionParams.actionId}, taskId: ${actionParams.taskId ?? "none"}`,
  );

  // 从原始 payload 中提取 scope 参数（按钮构建时写入 actionParams）
  const buttonScope = payload.actionParams?.scope;

  // 如果有任务队列，先在队列层面处理取消
  if (taskQueue) {
    const isCancel =
      actionParams.actionId === "jarvis_cancel_task" ||
      actionParams.actionId === "jarvis_cancel_all";

    if (isCancel) {
      if (actionParams.actionId === "jarvis_cancel_all" && buttonScope === "pending") {
        // "暂停排队"按钮：仅取消排队中的任务，不影响运行中的任务
        const pausedCount = card.pausePendingTasks();
        logger?.debug(`[CardCallback] Paused ${pausedCount} pending tasks`);
        await card.refresh(true);
        await card.autoFinishIfDone();
        return { success: true, message: `已暂停 ${pausedCount} 个排队任务` };
      } else if (actionParams.actionId === "jarvis_cancel_all") {
        // "取消全部"按钮：取消所有活跃任务
        const userId = payload.userId ?? payload.staffId ?? "";
        const cancelledCount = taskQueue.cancelUserTasks(userId);
        logger?.debug(`[CardCallback] Cancelled ${cancelledCount} tasks in queue`);
      } else if (actionParams.taskId) {
        const cancelled = taskQueue.cancelTask(actionParams.taskId);
        logger?.debug(`[CardCallback] Cancel task ${actionParams.taskId}: ${cancelled}`);
      }
    }
  }

  // "重试失败"按钮（scope=failed）：收集所有失败任务 ID 并返回
  if (actionParams.actionId === "jarvis_retry_task" && buttonScope === "failed") {
    const failedTaskIds: string[] = [];
    for (const task of card.getTasks()) {
      if (task.status === "failed") {
        failedTaskIds.push(task.taskId);
      }
    }

    if (failedTaskIds.length === 0) {
      return { success: false, message: "没有失败的任务需要重试" };
    }

    // 重置所有失败任务为 pending 状态
    for (const taskId of failedTaskIds) {
      await card.handleAction({
        actionId: "jarvis_retry_task",
        cardInstanceId: payload.outTrackId,
        taskId,
      });
    }

    logger?.debug(`[CardCallback] Retrying ${failedTaskIds.length} failed tasks`);
    return {
      success: true,
      message: `已重新排队 ${failedTaskIds.length} 个失败任务`,
      retryTaskId: failedTaskIds[0],
    };
  }

  // 委托给 JarvisCard 处理
  const result = await card.handleAction(actionParams);

  logger?.debug(`[CardCallback] Result: handled=${result.handled}, message=${result.message}`);

  // 如果是重试操作，返回需要重新入队的任务 ID
  if (actionParams.actionId === "jarvis_retry_task" && result.handled && actionParams.taskId) {
    return {
      success: true,
      message: result.message,
      retryTaskId: actionParams.taskId,
    };
  }

  return {
    success: result.handled,
    message: result.message,
  };
}

/**
 * 从回调 payload 中提取 action 参数
 *
 * 钉钉卡片回调的 actionParams 是一个 key-value 映射，
 * 我们约定使用 "jarvisAction" 键存储 JSON 编码的参数。
 */
function extractActionParams(payload: CardCallbackPayload): JarvisActionParams | null {
  // 方式 1: 从 actionParams 中提取
  if (payload.actionParams) {
    const jarvisAction = payload.actionParams.jarvisAction;
    if (jarvisAction) {
      return decodeActionParams(jarvisAction);
    }

    // 方式 2: 尝试从 actionParams 的各个字段直接构造
    const actionId = payload.actionParams.actionId;
    if (actionId) {
      return {
        actionId: actionId as JarvisActionParams["actionId"],
        cardInstanceId: payload.outTrackId,
        taskId: payload.actionParams.taskId,
        userId: payload.userId ?? payload.staffId,
      };
    }
  }

  // 方式 3: 从 cardPrivateData 中提取
  if (payload.cardPrivateData) {
    const jarvisAction = payload.cardPrivateData.jarvisAction;
    if (typeof jarvisAction === "string") {
      return decodeActionParams(jarvisAction);
    }
  }

  return null;
}

/**
 * 判断一个 Stream 回调事件是否为卡片按钮回调
 *
 * 用于 monitor.ts 中区分普通消息和卡片回调。
 * 钉钉卡片回调的 topic 为 "/v1.0/card/instances/callback"。
 */
export function isCardCallbackEvent(topic: string): boolean {
  return (
    topic === "/v1.0/card/instances/callback" ||
    (topic.includes("card") && topic.includes("callback"))
  );
}

/**
 * 解析 Stream 回调事件的 data 为 CardCallbackPayload
 */
export function parseCardCallbackData(data: string): CardCallbackPayload | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.outTrackId !== "string") return null;
    return record as unknown as CardCallbackPayload;
  } catch {
    return null;
  }
}
