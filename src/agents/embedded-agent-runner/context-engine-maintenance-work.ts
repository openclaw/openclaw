import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextEngine } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import type { createSessionMaintenanceOwner } from "../session-maintenance/coordinator.js";
import { log } from "./logger.js";

/** Maintenance owns cooperating descendants through the operation's actual settlement. */
export async function runContextEngineMaintenanceWork(
  run: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const work = new AsyncWorkScope();
  const context = work.run(() => AsyncLocalStorage.snapshot());
  // Accepted background work follows maintenance shutdown, not foreground completion.
  const cancel = () => context(() => work.beginClose(signal.reason));
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  try {
    await work.track(run);
  } finally {
    try {
      // Normal completion must not abort work that returned an early result.
      await AsyncWorkScope.runWhenAllIdle(
        () => [work],
        () => context(() => work.drain()),
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}

export async function disposeDeferredMaintenanceContextEngine(
  params: {
    contextEngine: ContextEngine;
    runInContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  },
  maintenance: Pick<ReturnType<typeof createSessionMaintenanceOwner>, "run" | "signal">,
): Promise<void> {
  try {
    await params.runInContext(() =>
      maintenance.run(() =>
        runContextEngineMaintenanceWork(async () => {
          await params.contextEngine.dispose?.();
        }, maintenance.signal),
      ),
    );
  } catch (err) {
    log.warn("context engine dispose failed after deferred maintenance", {
      errorMessage: formatErrorMessage(err),
    });
  }
}
