/** Coordinates one direct compaction attempt through explicit lifecycle phases. */
import { AsyncLocalStorage } from "node:async_hooks";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { executePreparedCompactionSession } from "./compaction-session-execution.js";
import {
  prepareDirectCompactionAttempt,
  type PreparedCompactEmbeddedAgentSessionParams,
} from "./direct-compaction-preparation.js";
import {
  buildPreparedCompactionRuntime,
  type PreparedCompactionCleanup,
} from "./prepared-compaction-runtime.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export async function compactEmbeddedAgentSessionDirectOnce(
  params: PreparedCompactEmbeddedAgentSessionParams,
): Promise<EmbeddedAgentCompactResult> {
  const callerResult = createDeferredCore<EmbeddedAgentCompactResult>();
  const trackOwner = captureAsyncWorkTracker();
  const parentSignal = getAsyncWorkSignal();
  const cancellationSignal =
    params.abortSignal && parentSignal
      ? AbortSignal.any([params.abortSignal, parentSignal])
      : (params.abortSignal ?? parentSignal);
  const work = new AsyncWorkScope();
  const context = work.run(() => AsyncLocalStorage.snapshot());
  const cleanupWork = new AsyncWorkScope();
  const cleanupContext = cleanupWork.run(() => AsyncLocalStorage.snapshot());
  let cleanup: PreparedCompactionCleanup | undefined;
  const runAttempt = async () => {
    const preparation = await prepareDirectCompactionAttempt(params);
    if (!preparation.ok) {
      return preparation.result;
    }
    try {
      const runtime = await buildPreparedCompactionRuntime(preparation.value, (preparedCleanup) => {
        cleanup = preparedCleanup;
      });
      return await executePreparedCompactionSession(runtime);
    } catch (err) {
      return preparation.value.fail(formatErrorMessage(err), err);
    } finally {
      cleanup?.restoreSkillEnvironment();
    }
  };
  void trackOwner(async () => {
    const closeWork = () => {
      context(() => work.beginClose(cancellationSignal?.reason));
      cleanupContext(() => cleanupWork.beginClose(cancellationSignal?.reason));
    };
    cancellationSignal?.addEventListener("abort", closeWork, { once: true });
    if (cancellationSignal?.aborted) {
      closeWork();
    }
    try {
      callerResult.resolve(await work.track(runAttempt));
    } catch (error) {
      callerResult.reject(error);
    } finally {
      try {
        // Session retirement has already revoked authority. Its accepted work still needs tools.
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => context(() => work.beginClose()),
        );
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => cleanupWork.track(() => cleanupContext(() => cleanup?.disposeToolRuntimes())),
        );
      } finally {
        try {
          await AsyncWorkScope.runWhenAllIdle(
            () => [work, cleanupWork],
            () => cleanupContext(() => cleanupWork.beginClose()),
          );
          await AsyncWorkScope.runWhenAllIdle(
            () => [work, cleanupWork],
            () =>
              Promise.all([context(() => work.drain()), cleanupContext(() => cleanupWork.drain())]),
          );
        } finally {
          cancellationSignal?.removeEventListener("abort", closeWork);
        }
      }
    }
  }).catch(callerResult.reject);
  return await callerResult.promise;
}
