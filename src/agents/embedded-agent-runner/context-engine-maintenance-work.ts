import { AsyncLocalStorage } from "node:async_hooks";
import { hasSameContextEngineInstance } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import type { createSessionMaintenanceOwner } from "../session-maintenance/coordinator.js";
import { log } from "./logger.js";

export type ContextEngineMaintenanceResources = {
  closeFactoryWork: () => Promise<void>;
  release: () => Promise<void>;
};

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
    factoryResourceOwners?: ReadonlySet<ContextEngineMaintenanceResources>;
  },
  maintenance: Pick<ReturnType<typeof createSessionMaintenanceOwner>, "run" | "signal">,
): Promise<void> {
  const failures: unknown[] = [];
  const resources = [...(params.factoryResourceOwners ?? [])];
  try {
    await params.runInContext(() =>
      maintenance.run(() =>
        runContextEngineMaintenanceWork(async () => {
          const disposal = (async () => {
            await params.contextEngine.dispose?.();
          })();
          const factoryWork = resources.map(({ closeFactoryWork }) =>
            trackAsyncWork(closeFactoryWork),
          );
          const outcomes = await Promise.allSettled([disposal, ...factoryWork]);
          for (const outcome of outcomes) {
            if (outcome.status === "rejected") {
              failures.push(outcome.reason);
            }
          }
        }, maintenance.signal),
      ),
    );
  } catch (error) {
    failures.push(error);
  }
  // The maintenance owner retains leases until engine and factory descendants have joined.
  const releases = await Promise.allSettled(resources.map(async (owner) => await owner.release()));
  for (const outcome of releases) {
    if (outcome.status === "rejected") {
      failures.push(outcome.reason);
    }
  }
  for (const error of failures) {
    log.warn("context engine dispose failed after deferred maintenance", {
      errorMessage: formatErrorMessage(error),
    });
  }
}

type ContextEngineFactoryWork = {
  contextEngine: ContextEngine;
  factoryResourceOwners: Set<ContextEngineMaintenanceResources>;
};

/** Shared engine instances retain every factory lifetime until their final disposer starts. */
export function mergeContextEngineFactoryWork(
  params: ContextEngineFactoryWork,
  activeEngine: ContextEngine,
  activeResources: Set<ContextEngineMaintenanceResources>,
  superseded?: ContextEngineFactoryWork,
): Set<ContextEngineMaintenanceResources> {
  if (superseded && hasSameContextEngineInstance(superseded.contextEngine, params.contextEngine)) {
    for (const resources of superseded.factoryResourceOwners) {
      params.factoryResourceOwners.add(resources);
    }
  }
  if (hasSameContextEngineInstance(params.contextEngine, activeEngine)) {
    for (const resources of params.factoryResourceOwners) {
      activeResources.add(resources);
    }
    return activeResources;
  }
  return params.factoryResourceOwners;
}
