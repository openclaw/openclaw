type QueueStatus = "queued" | "immediate";

const chatQueues = new Map<string, Promise<void>>();

/**
 * 构建队列键
 *
 * 使用 accountId + chatId 作为维度，确保同一会话中的消息串行处理。
 * 不同会话之间互不影响，可以并行处理。
 */
export function buildQueueKey(accountId: string, chatId: string): string {
  return `${accountId}:${chatId}`;
}

/**
 * 检查指定会话是否有正在处理的任务
 */
export function hasActiveTask(key: string): boolean {
  return chatQueues.has(key);
}

/**
 * 将任务加入串行队列
 *
 * 如果队列中已有任务（status="queued"），新任务会排队等待；
 * 如果队列为空（status="immediate"），任务立即执行。
 *
 * 即使前一个任务失败，后续任务仍会继续执行（.then(task, task)）。
 */
export function enqueueWeComChatTask(params: {
  accountId: string;
  chatId: string;
  task: () => Promise<void>;
}): { status: QueueStatus; promise: Promise<void> } {
  const { accountId, chatId, task } = params;
  const key = buildQueueKey(accountId, chatId);
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const status: QueueStatus = chatQueues.has(key) ? "queued" : "immediate";

  // continue queue even if previous task failed
  const next = prev.then(task, task);
  chatQueues.set(key, next);

  const cleanup = (): void => {
    // 只有当前任务仍是队列末尾时才清理，避免误删后续任务
    if (chatQueues.get(key) === next) {
      chatQueues.delete(key);
    }
  };

  next.then(cleanup, cleanup);

  return { status, promise: next };
}

/** @internal 测试专用：重置所有队列状态 */
export function _resetChatQueueState(): void {
  chatQueues.clear();
}
