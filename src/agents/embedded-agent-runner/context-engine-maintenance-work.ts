import { AsyncLocalStorage } from "node:async_hooks";
import { hasSameContextEngineInstance } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
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
    factoryWorkClosers?: ReadonlySet<() => Promise<void>>;
  },
  maintenance: Pick<ReturnType<typeof createSessionMaintenanceOwner>, "run" | "signal">,
): Promise<void> {
  try {
    await params.runInContext(() =>
      maintenance.run(() =>
        runContextEngineMaintenanceWork(async () => {
          const disposal = (async () => {
            await params.contextEngine.dispose?.();
          })();
          const factoryWork = [...(params.factoryWorkClosers ?? [])].map((close) =>
            trackAsyncWork(close),
          );
          await Promise.all([disposal, ...factoryWork]);
        }, maintenance.signal),
      ),
    );
  } catch (err) {
    log.warn("context engine dispose failed after deferred maintenance", {
      errorMessage: formatErrorMessage(err),
    });
  }
}

type ContextEngineFactoryWork = {
  contextEngine: ContextEngine;
  factoryWorkClosers: Set<() => Promise<void>>;
};

/** Shared engine instances retain every factory lifetime until their final disposer starts. */
export function mergeContextEngineFactoryWork(
  params: ContextEngineFactoryWork,
  activeEngine: ContextEngine,
  activeClosers: Set<() => Promise<void>>,
  superseded?: ContextEngineFactoryWork,
): Set<() => Promise<void>> {
  if (superseded && hasSameContextEngineInstance(superseded.contextEngine, params.contextEngine)) {
    for (const close of superseded.factoryWorkClosers) {
      params.factoryWorkClosers.add(close);
    }
  }
  if (hasSameContextEngineInstance(params.contextEngine, activeEngine)) {
    for (const close of params.factoryWorkClosers) {
      activeClosers.add(close);
    }
    return activeClosers;
  }
  return params.factoryWorkClosers;
}
