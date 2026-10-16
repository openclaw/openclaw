import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

const monitorTaskSignal = new AsyncLocalStorage<AbortSignal>();
const MATRIX_MONITOR_IDLE_TIMEOUT_MS = 30_000;

export function getMatrixMonitorTaskSignal(): AbortSignal | undefined {
  return monitorTaskSignal.getStore();
}

export function createMatrixMonitorTaskRunner(params: {
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
}) {
  const inFlight = new Set<Promise<void>>();
  const shutdownController = new AbortController();
  let closed = false;

  const runDetachedTask = (label: string, task: () => Promise<void>): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    // Retained descendants keep the runner's shutdown signal after their task settles.
    const trackedTask: Promise<void> = monitorTaskSignal
      .run(shutdownController.signal, () => Promise.resolve().then(task))
      .catch((error: unknown) => {
        const message = String(error);
        params.logVerboseMessage(`matrix: ${label} failed (${message})`);
        params.logger.warn("matrix background task failed", {
          task: label,
          error: message,
        });
      })
      .finally(() => {
        inFlight.delete(trackedTask);
      });
    inFlight.add(trackedTask);
    return trackedTask;
  };

  const waitForIdle = async (): Promise<void> => {
    // The window resets when a task settles. A hung join must not block shutdown.
    while (inFlight.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), MATRIX_MONITOR_IDLE_TIMEOUT_MS);
          timer.unref();
        }),
        ...inFlight,
      ]);
      clearTimeout(timer);
      if (timedOut) {
        shutdownController.abort();
        params.logger.warn("matrix waitForIdle timed out", {
          idleTimeoutMs: MATRIX_MONITOR_IDLE_TIMEOUT_MS,
          remaining: inFlight.size,
        });
        return;
      }
    }
  };

  return {
    close: () => {
      closed = true;
      shutdownController.abort();
    },
    runDetachedTask,
    waitForIdle,
  };
}
