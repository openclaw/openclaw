import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextEngine } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import {
  withSessionTurn,
  type SessionTurnAdmission,
} from "../../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.state.js";
import type { SessionWatchdogWait } from "../../sessions/session-controller.watchdog.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { PreparedModelRuntimeLease } from "../prepared-model-runtime.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import type { ContextEngineMaintenanceResources } from "./context-engine-maintenance-work.js";
import { resolveGlobalLane } from "./lanes.js";
import { log } from "./logger.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

/** Both compaction runtimes cancel pending queue admission before releasing their writer. */
export function enqueueCompactionInLanes<T>(
  params: Pick<
    CompactEmbeddedAgentSessionParams,
    "agentId" | "sessionKey" | "sessionId" | "spawnedBy" | "lane" | "enqueue" | "abortSignal"
  >,
  run: () => Promise<T>,
): Promise<T> {
  const globalLane = resolveGlobalLane(params.lane, params);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const operation = getCurrentSessionControllerOwner();
  let queued = true;
  let wait: SessionWatchdogWait | undefined;
  const beginWait = () => {
    if (wait || !queued) {
      return;
    }
    wait = operation?.watchdog.beginWait({
      kind: "global_capacity",
      isCurrent: () => {
        if (!queued || !operation) {
          return false;
        }
        assertSessionControllerOperation(operation);
        return true;
      },
    });
  };
  const finishWait = () => {
    queued = false;
    wait?.close();
  };
  try {
    return enqueueGlobal(
      async () => {
        finishWait();
        params.abortSignal?.throwIfAborted();
        if (operation) {
          assertSessionControllerOperation(operation);
        }
        operation?.watchdog.progress("semantic", "compaction:capacity_admitted");
        return await run();
      },
      { abortSignal: params.abortSignal, onQueued: beginWait },
    ).finally(finishWait);
  } catch (error) {
    finishWait();
    throw error;
  }
}

/** A timeout can return a result while the exact turn still owns raw work and disposal. */
export async function withQueuedCompactionTurn(
  admission: SessionTurnAdmission,
  run: (
    operation: ReplyOperation | undefined,
    signal: AbortSignal,
    onSettled: (cleanup: () => void) => void,
  ) => Promise<EmbeddedAgentCompactResult>,
): Promise<EmbeddedAgentCompactResult> {
  const result = createDeferredCore<EmbeddedAgentCompactResult>();
  const trackOwner = captureAsyncWorkTracker();
  void trackOwner(() =>
    withSessionTurn(admission, async (operation, signal) => {
      const work = new AsyncWorkScope();
      const cleanups: Array<() => void> = [];
      try {
        const value = await work.track(() =>
          run(operation, signal, (cleanup) => cleanups.push(cleanup)),
        );
        if (work.hasPendingWork && !admission.replyOperation) {
          result.resolve(value);
        }
        return value;
      } catch (error) {
        if (work.hasPendingWork && !admission.replyOperation) {
          result.reject(error);
        }
        throw error;
      } finally {
        // Standalone callers may get a result early, but this turn retains raw work.
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => work.drain(),
        );
        await Promise.all(cleanups.toReversed().map(async (cleanup) => cleanup()));
      }
    }),
  ).then(result.resolve, result.reject);
  return await result.promise;
}

/** Keeps physical cleanup separate from the compaction result and transcript fences. */
export async function runForegroundCompactionWork(
  run: (owner: {
    adoptLease: (lease: PreparedModelRuntimeLease) => ContextEngineMaintenanceResources;
    resolveEngine: (factory: () => Promise<ContextEngine>) => Promise<ContextEngine>;
    captureContext: () => void;
    transferEngine: () => void;
  }) => Promise<EmbeddedAgentCompactResult>,
  abortSignal?: AbortSignal,
): Promise<EmbeddedAgentCompactResult> {
  const result = createDeferredCore<EmbeddedAgentCompactResult>();
  const trackOwner = captureAsyncWorkTracker();
  const parentSignal = getAsyncWorkSignal();
  const cancellationSignal =
    abortSignal && parentSignal
      ? AbortSignal.any([abortSignal, parentSignal])
      : (abortSignal ?? parentSignal);
  void trackOwner(async () => {
    const work = new AsyncWorkScope();
    const factoryWork = new AsyncWorkScope();
    let runInContext = work.run(() => AsyncLocalStorage.snapshot());
    let factoryContext = factoryWork.run(() => AsyncLocalStorage.snapshot());
    let foregroundClosed: Promise<void> | undefined;
    const closeForegroundWork = () =>
      (foregroundClosed ??= AsyncWorkScope.runWhenAllIdle(
        () => [work],
        () => runInContext(() => work.drain()),
      ));
    let factoryClosed: Promise<void> | undefined;
    const closeFactoryWork = () => (factoryClosed ??= factoryContext(() => factoryWork.drain()));
    let lease: PreparedModelRuntimeLease | undefined;
    let engine: ContextEngine | undefined;
    let engineTransferred = false;
    const closeFromParent = () => {
      runInContext(() => work.beginClose(cancellationSignal?.reason));
      if (!engineTransferred) {
        factoryContext(() => factoryWork.beginClose(cancellationSignal?.reason));
      }
    };
    cancellationSignal?.addEventListener("abort", closeFromParent, { once: true });
    if (cancellationSignal?.aborted) {
      closeFromParent();
    }
    try {
      result.resolve(
        await work.track(() =>
          run({
            adoptLease: (acquired) => {
              lease = acquired;
              return {
                closeFactoryWork,
                release: async () => {
                  // Fast maintenance still shares any admitted foreground preparation tails.
                  await closeForegroundWork();
                  await acquired[Symbol.asyncDispose]();
                },
              };
            },
            resolveEngine: (factory) =>
              factoryWork.track(async () => {
                factoryContext = AsyncLocalStorage.snapshot();
                engine = await factory();
                return engine;
              }),
            captureContext: () => {
              runInContext = AsyncLocalStorage.snapshot();
            },
            transferEngine: () => {
              engine = undefined;
              engineTransferred = true;
            },
          }),
        ),
      );
    } catch (error) {
      result.reject(error);
    } finally {
      try {
        await closeForegroundWork();
        if (!engineTransferred) {
          // Factory services can need their disposer to start before their signal closes.
          const disposal = factoryContext(() =>
            factoryWork.track(async () => {
              try {
                await engine?.dispose?.();
              } catch (error) {
                log.warn("context engine dispose failed", {
                  errorMessage: formatErrorMessage(error),
                });
              }
            }),
          );
          await Promise.all([disposal, closeFactoryWork()]);
        }
      } finally {
        cancellationSignal?.removeEventListener("abort", closeFromParent);
        if (!engineTransferred) {
          await lease?.[Symbol.asyncDispose]();
        }
      }
    }
  }).catch(result.reject);
  return await result.promise;
}
