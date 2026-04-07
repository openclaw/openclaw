type QueueStatus = "queued" | "immediate";

const chatQueues = new Map<string, Promise<void>>();

/**
 * Build a queue key.
 *
 * Uses accountId + chatId as the dimension to ensure messages within the same
 * conversation are processed serially. Different conversations are independent
 * and can be processed in parallel.
 */
export function buildQueueKey(accountId: string, chatId: string): string {
  return `${accountId}:${chatId}`;
}

/**
 * Check whether the specified conversation has an active task.
 */
export function hasActiveTask(key: string): boolean {
  return chatQueues.has(key);
}

/**
 * Enqueue a task into the serial queue.
 *
 * If there is already a task in the queue (status="queued"), the new task waits in line;
 * if the queue is empty (status="immediate"), the task executes immediately.
 *
 * Even if the previous task fails, subsequent tasks will still execute (.then(task, task)).
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
    // Only clean up when the current task is still the tail of the queue, to avoid deleting subsequent tasks
    if (chatQueues.get(key) === next) {
      chatQueues.delete(key);
    }
  };

  next.then(cleanup, cleanup);

  return { status, promise: next };
}

/** @internal Test-only: reset all queue state */
export function _resetChatQueueState(): void {
  chatQueues.clear();
}
