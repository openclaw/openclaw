import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

interface SequentialQueueOptions {
  /** Timed-out tasks keep running, but stop blocking later same-key tasks (#70133). */
  onTaskTimeout?: (key: string, timeoutMs: number) => void;
}

export function createSequentialQueue(options: SequentialQueueOptions = {}) {
  const queues = new Map<string, Promise<void>>();
  const onTaskTimeout = options.onTaskTimeout;

  return (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const wrapped = () =>
      raceWithTimeout(task, DEFAULT_TASK_TIMEOUT_MS, () => {
        onTaskTimeout?.(key, DEFAULT_TASK_TIMEOUT_MS);
      });
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
