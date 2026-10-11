import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

type MatrixMonitorTaskRunnerState = {
  shutdownSignal: AbortSignal;
};

type MatrixMonitorTaskContext = {
  runner: MatrixMonitorTaskRunnerState;
  settled: boolean;
  signal: AbortSignal;
};

const monitorTaskContext = new AsyncLocalStorage<MatrixMonitorTaskContext>();
const MATRIX_MONITOR_IDLE_TIMEOUT_MS = 30_000;

export function getMatrixMonitorTaskSignal(): AbortSignal | undefined {
  const context = monitorTaskContext.getStore();
  // A settled task's descendants still belong to this monitor. Retirement
  // aborts the runner signal; the task signal would already be gone.
  return context?.settled ? context.runner.shutdownSignal : context?.signal;
}

function createIdleTimeoutPromise(timeoutMs: number): {
  promise: Promise<"timeout">;
  clear: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
    timeoutId.unref?.();
  });
  return {
    promise,
    clear: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
}

function settledOutcome(): "settled" {
  return "settled";
}

export function createMatrixMonitorTaskRunner(params: {
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
}) {
  const inFlight = new Map<Promise<void>, AbortController>();
  const shutdownController = new AbortController();
  const runner: MatrixMonitorTaskRunnerState = { shutdownSignal: shutdownController.signal };
  let closed = false;

  const runDetachedTask = (label: string, task: () => Promise<void>): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    const controller = new AbortController();
    const context: MatrixMonitorTaskContext = {
      runner,
      settled: false,
      signal: AbortSignal.any([controller.signal, runner.shutdownSignal]),
    };
    const trackedTask: Promise<void> = monitorTaskContext
      .run(context, () => Promise.resolve().then(task))
      .catch((error: unknown) => {
        const message = String(error);
        params.logVerboseMessage(`matrix: ${label} failed (${message})`);
        params.logger.warn("matrix background task failed", {
          task: label,
          error: message,
        });
      })
      .finally(() => {
        context.settled = true;
        inFlight.delete(trackedTask);
      });
    inFlight.set(trackedTask, controller);
    return trackedTask;
  };

  const waitForIdle = async (): Promise<void> => {
    // The window resets when a task settles. A hung join must not block shutdown.
    while (inFlight.size > 0) {
      const snapshot = Array.from(inFlight.keys());
      const timeout = createIdleTimeoutPromise(MATRIX_MONITOR_IDLE_TIMEOUT_MS);
      const outcome = await Promise.race([
        timeout.promise,
        ...snapshot.map((task) => task.then(settledOutcome, settledOutcome)),
      ]);
      timeout.clear();
      if (outcome === "timeout") {
        shutdownController.abort();
        for (const controller of inFlight.values()) {
          controller.abort();
        }
        const remaining = inFlight.size;
        params.logVerboseMessage(
          `matrix: waitForIdle made no progress within ${MATRIX_MONITOR_IDLE_TIMEOUT_MS}ms; continuing retirement with ${remaining} task(s) still in flight`,
        );
        params.logger.warn("matrix waitForIdle timed out", {
          idleTimeoutMs: MATRIX_MONITOR_IDLE_TIMEOUT_MS,
          remaining,
        });
        return;
      }
    }
  };

  return {
    close: () => {
      closed = true;
      shutdownController.abort();
      for (const controller of inFlight.values()) {
        controller.abort();
      }
    },
    runDetachedTask,
    waitForIdle,
  };
}
