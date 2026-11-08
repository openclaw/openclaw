import { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

interface SequentialQueueOptions {
  /** Timed-out tasks keep running, but stop blocking later same-key tasks (#70133). */
  onTaskTimeout?: (key: string, timeoutMs: number) => void;
}

export function createSequentialQueue(options: SequentialQueueOptions = {}) {
  const queues = new Map<string, Promise<void>>();
  const onTaskTimeout = options.onTaskTimeout;

  return (key: string, task: () => Promise<void>): Promise<void> =>
    enqueueKeyedTask({
      tails: queues,
      key,
      task: () =>
        raceWithTimeout(task, DEFAULT_TASK_TIMEOUT_MS, () => {
          onTaskTimeout?.(key, DEFAULT_TASK_TIMEOUT_MS);
        }),
    });
}
