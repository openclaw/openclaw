import { AsyncLocalStorage } from "node:async_hooks";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { bindOperatorModelExecution } from "../admitted-run-context.js";
import { hasModelFallbackStop } from "../failover-error.js";
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
  let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
  const closeFromModelPolicy = () => context(() => work.beginClose(modelExecution?.signal.reason));
  const runAttempt = async () => {
    const preparation = await prepareDirectCompactionAttempt(
      {
        ...params,
        abortSignal: work.signal,
        assertTranscriptBytePreflightActive: params.assertTranscriptBytePreflightActive
          ? async () => {
              await params.assertTranscriptBytePreflightActive?.();
              modelExecution?.assertCurrent();
            }
          : undefined,
      },
      (model) => {
        modelExecution = bindOperatorModelExecution(params.transcriptByteOperatorAuthority, model);
        modelExecution?.signal.addEventListener("abort", closeFromModelPolicy, { once: true });
        if (modelExecution?.signal.aborted) {
          closeFromModelPolicy();
        }
      },
    );
    if (!preparation.ok) {
      return preparation.result;
    }
    try {
      const runtime = await buildPreparedCompactionRuntime(preparation.value, (preparedCleanup) => {
        cleanup = preparedCleanup;
      });
      return await executePreparedCompactionSession(runtime);
    } catch (err) {
      if (hasModelFallbackStop(err)) {
        throw err;
      }
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
          modelExecution?.signal.removeEventListener("abort", closeFromModelPolicy);
          modelExecution?.release();
        }
      }
    }
  }).catch(callerResult.reject);
  return await callerResult.promise;
}
