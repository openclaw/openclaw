import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextEngine } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { PreparedModelRuntimeLease } from "../prepared-model-runtime.js";
import { log } from "./logger.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export type ForegroundCompactionOwner = {
  adoptLease: (lease: PreparedModelRuntimeLease) => void;
  resolveEngine: (factory: () => Promise<ContextEngine>) => Promise<ContextEngine>;
  closeFactoryWork: () => Promise<void>;
  captureContext: () => void;
  transferEngine: (completion: Promise<void>) => void;
};

/** Keeps physical cleanup separate from the compaction result and transcript fences. */
export async function runForegroundCompactionWork(
  run: (owner: ForegroundCompactionOwner) => Promise<EmbeddedAgentCompactResult>,
): Promise<EmbeddedAgentCompactResult> {
  const result = createDeferredCore<EmbeddedAgentCompactResult>();
  const trackOwner = captureAsyncWorkTracker();
  const parentSignal = getAsyncWorkSignal();
  void trackOwner(async () => {
    const work = new AsyncWorkScope();
    const factoryWork = new AsyncWorkScope();
    const cleanupWork = new AsyncWorkScope();
    let runInContext = work.run(() => AsyncLocalStorage.snapshot());
    let factoryContext = factoryWork.run(() => AsyncLocalStorage.snapshot());
    let cleanupContext = cleanupWork.run(() => AsyncLocalStorage.snapshot());
    let factoryClosed: Promise<void> | undefined;
    const closeFactoryWork = () => (factoryClosed ??= factoryContext(() => factoryWork.drain()));
    let lease: PreparedModelRuntimeLease | undefined;
    let engine: ContextEngine | undefined;
    let deferredCompletion: Promise<void> | undefined;
    const closeFromParent = () => {
      runInContext(() => work.beginClose(parentSignal?.reason));
      if (!deferredCompletion) {
        factoryContext(() => factoryWork.beginClose(parentSignal?.reason));
      }
      cleanupContext(() => cleanupWork.beginClose(parentSignal?.reason));
    };
    parentSignal?.addEventListener("abort", closeFromParent, { once: true });
    if (parentSignal?.aborted) {
      closeFromParent();
    }
    try {
      result.resolve(
        await work.track(() =>
          run({
            adoptLease: (acquired) => {
              lease = acquired;
            },
            resolveEngine: (factory) =>
              factoryWork.track(async () => {
                factoryContext = AsyncLocalStorage.snapshot();
                engine = await factory();
                return engine;
              }),
            closeFactoryWork,
            captureContext: () => {
              runInContext = AsyncLocalStorage.snapshot();
            },
            transferEngine: (completion) => {
              engine = undefined;
              deferredCompletion = completion;
            },
          }),
        ),
      );
    } catch (error) {
      result.reject(error);
    } finally {
      try {
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => runInContext(() => work.drain()),
        );
        if (!deferredCompletion) {
          cleanupContext = factoryContext(() =>
            cleanupWork.run(() => AsyncLocalStorage.snapshot()),
          );
          // Factory services can need their disposer to start before their signal closes.
          const disposal = cleanupContext(() =>
            cleanupWork.track(async () => {
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
          await AsyncWorkScope.runWhenAllIdle(
            () => [cleanupWork],
            () => cleanupContext(() => cleanupWork.drain()),
          );
        }
      } finally {
        parentSignal?.removeEventListener("abort", closeFromParent);
        const retained = lease;
        if (retained && deferredCompletion) {
          // Background maintenance retains its independent shutdown owner.
          void deferredCompletion
            .then(closeFactoryWork, closeFactoryWork)
            .then(retained.release, retained.release);
        } else {
          retained?.release();
        }
      }
    }
  }).catch(result.reject);
  return await result.promise;
}
