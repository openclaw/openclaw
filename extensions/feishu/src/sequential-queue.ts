import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

interface SequentialQueueOptions {
  /** Default five-minute cap; nonpositive/nonfinite values preserve unbounded FIFO ordering. */
  taskTimeoutMs?: number;
  /** Timed-out tasks keep running, but stop blocking later same-key tasks (#70133). */
  onTaskTimeout?: (key: string, timeoutMs: number) => void;
}

export function createSequentialQueue(options: SequentialQueueOptions = {}) {
  const queues = new Map<string, Promise<void>>();
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const onTaskTimeout = options.onTaskTimeout;

  return (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const wrapped = () => boundedRun(key, task, taskTimeoutMs, onTaskTimeout);
    const next = previous.then(wrapped, wrapped);
    queues.set(key, next);
    const cleanup = () => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  };
}

async function boundedRun(
  key: string,
  task: () => Promise<void>,
  timeoutMs: number,
  onTaskTimeout: ((key: string, timeoutMs: number) => void) | undefined,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return task();
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      try {
        onTaskTimeout?.(key, resolvedTimeoutMs);
      } catch {
        // Swallow logging errors so they cannot poison the queue chain.
      }
      resolve();
    }, resolvedTimeoutMs);
  });
  try {
    await Promise.race([task(), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
