import { AsyncLocalStorage } from "node:async_hooks";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PreparedModelRuntimeLease } from "./prepared-model-runtime.js";

/** Retains isolated completion resources through admitted setup and transport cleanup. */
export async function runWithIsolatedCompletionResources<T>(
  run: (
    acceptLease: (lease: PreparedModelRuntimeLease) => void,
    captureWorkContext: () => void,
  ) => Promise<T>,
): Promise<T> {
  const result = createDeferredCore<T>();
  const trackOwner = captureAsyncWorkTracker();
  const parentSignal = getAsyncWorkSignal();
  void trackOwner(async () => {
    const work = new AsyncWorkScope();
    let lease: PreparedModelRuntimeLease | undefined;
    let runInContext = work.run(() => AsyncLocalStorage.snapshot());
    const closeFromParent = () => runInContext(() => work.beginClose(parentSignal?.reason));
    parentSignal?.addEventListener("abort", closeFromParent, { once: true });
    if (parentSignal?.aborted) {
      closeFromParent();
    }
    try {
      result.resolve(
        await work.track(() =>
          run(
            (acquired) => {
              lease = acquired;
            },
            () => {
              runInContext = AsyncLocalStorage.snapshot();
            },
          ),
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
      } finally {
        parentSignal?.removeEventListener("abort", closeFromParent);
        lease?.release();
      }
    }
  }).catch(result.reject);
  return await result.promise;
}
