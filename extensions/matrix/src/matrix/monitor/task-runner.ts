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

export function getMatrixMonitorTaskSignal(): AbortSignal | undefined {
  const context = monitorTaskContext.getStore();
  return context?.settled ? context.runner.shutdownSignal : context?.signal;
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
        // Descendants retain shutdown ownership, but no longer belong to a settled task.
        context.settled = true;
        inFlight.delete(trackedTask);
      });
    inFlight.set(trackedTask, controller);
    return trackedTask;
  };

  const waitForIdle = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight.keys()));
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
