import { AsyncLocalStorage } from "node:async_hooks";
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
  releaseResources?: () => Promise<void>,
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
        () => context(() => work.beginClose()),
      );
      // Abort descendants still own resources; lease release can then admit its cleanup here.
      await AsyncWorkScope.runWhenAllIdle(
        () => [work],
        () =>
          context(async () => {
            try {
              await releaseResources?.();
            } finally {
              await work.drain();
            }
          }),
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
  const settle = async (work: Promise<unknown>[]) => {
    for (const outcome of await Promise.allSettled(work)) {
      if (outcome.status === "rejected") {
        failures.push(outcome.reason);
      }
    }
  };
  const resources = [...(params.factoryResourceOwners ?? [])];
  let releasing: Promise<void> | undefined;
  const releaseResources = () =>
    (releasing ??= settle(resources.map(async (owner) => await owner.release())));
  try {
    await params.runInContext(() =>
      maintenance.run(() =>
        runContextEngineMaintenanceWork(
          async () => {
            const disposal = (async () => {
              await params.contextEngine.dispose?.();
            })();
            const factoryWork = resources.map(({ closeFactoryWork }) =>
              trackAsyncWork(closeFactoryWork),
            );
            await settle([disposal, ...factoryWork]);
          },
          maintenance.signal,
          releaseResources,
        ),
      ),
    );
  } catch (error) {
    failures.push(error);
  }
  // Admission failure still joins the same release, without repeating an admitted cleanup.
  await releaseResources();
  for (const error of failures) {
    log.warn("context engine dispose failed after deferred maintenance", {
      errorMessage: formatErrorMessage(error),
    });
  }
}
