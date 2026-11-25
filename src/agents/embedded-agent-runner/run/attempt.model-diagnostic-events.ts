import { observeAsyncIterator } from "@openclaw/llm-core";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import { captureAsyncWorkTracker } from "../../../shared/async-work-scope.js";
import { settlesWithin } from "../../../shared/settle-within.js";
import type { StreamFn } from "../../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import {
  createModelLifecycle,
  type ModelCallDiagnosticContext,
  type ModelCallLifecycle,
} from "./attempt.model-diagnostic-lifecycle.js";
import {
  createModelObserver,
  createModelPromptStats,
} from "./attempt.model-diagnostic-observation.js";

const MODEL_CALL_STREAM_RETURN_TIMEOUT_MS = 1000;

async function safeReturnIterator(
  iterator: AsyncIterator<unknown>,
  trackCleanup: ReturnType<typeof captureAsyncWorkTracker>,
): Promise<void> {
  const returnResult = trackCleanup(() => iterator.return?.());
  // Early consumer return should not hang diagnostic completion forever; give
  // provider cleanup a short chance, then emit completion for the observed call.
  await settlesWithin(
    Promise.resolve(returnResult).catch(() => undefined),
    MODEL_CALL_STREAM_RETURN_TIMEOUT_MS,
  );
}

function throwModelCallError(lifecycle: ModelCallLifecycle, error: unknown): never {
  lifecycle.emitError(error);
  throw error;
}

function observeModelCallIterator<T>(
  iterator: AsyncIterator<T>,
  lifecycle: ModelCallLifecycle,
  observeSharedResult: () => Promise<unknown>,
): AsyncIterableIterator<T> {
  const trackCleanup = captureAsyncWorkTracker();
  const observed = observeAsyncIterator({
    iterator: () => iterator,
    onEvent: (chunk) => lifecycle.observeChunk(chunk),
    onDone() {
      // Result decorators retain cleanup ownership and explicit result() errors.
      if (!lifecycle.observer.state.terminalError) {
        void trackCleanup(observeSharedResult).catch(() => undefined);
      } else {
        lifecycle.emitCompleted();
      }
    },
    onError: (error) => lifecycle.emitError(error),
    onClose(_iterator, reason) {
      // Diagnostics historically close only on return; source/observer/consumer
      // errors leave cleanup with the provider. Keep that policy at this boundary.
      if (reason === "return") {
        return safeReturnIterator(iterator, trackCleanup).then(() => lifecycle.emitCompleted());
      }
      return undefined;
    },
    async onUnopenedReturn(value) {
      // Acquired eagerly; preserve the unopened return's unawaited value.
      await safeReturnIterator(iterator, trackCleanup);
      lifecycle.emitCompleted();
      return { done: true, value };
    },
  });
  let returning: Promise<IteratorResult<T>> | undefined;
  const advance = () => observed.next();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (returning) {
        return returning.then(() => ({ done: true as const, value: undefined }));
      }
      return lifecycle.runInTransportContext(advance);
    },
    return(value) {
      returning ??= lifecycle.runInTransportContext(() => observed.return(value));
      return returning;
    },
    throw(error) {
      return lifecycle.runInTransportContext(() => observed.throw(error));
    },
  };
}

function createSharedResultObserver(
  stream: MutableAssistantMessageEventStream,
  lifecycle: ModelCallLifecycle,
): MutableAssistantMessageEventStream["result"] {
  const resultFn = stream.result.bind(stream);
  // The stream contract exposes one no-argument final result. Share observation
  // across iterator exhaustion and explicit callers, including rejected results.
  let cached: ReturnType<MutableAssistantMessageEventStream["result"]> | undefined;
  return () => {
    if (!cached) {
      cached = Promise.resolve()
        .then(() => lifecycle.runInTransportContext(resultFn))
        .then((resolved) => {
          lifecycle.observer.observeFinalResult(lifecycle.eventBase, lifecycle.startedAt, resolved);
          lifecycle.emitCompleted();
          return resolved;
        })
        .catch((err: unknown) => throwModelCallError(lifecycle, err));
      // Drain-only consumers never await this promise; retain rejection for callers.
      void cached.catch(() => undefined);
    }
    return cached;
  };
}

function observeModelCallStream(
  stream: MutableAssistantMessageEventStream,
  lifecycle: ModelCallLifecycle,
): MutableAssistantMessageEventStream {
  const observedResult = createSharedResultObserver(stream, lifecycle);
  const observedIterator = () => {
    try {
      return observeModelCallIterator(
        lifecycle.runInTransportContext(() => stream[Symbol.asyncIterator]()),
        lifecycle,
        observedResult,
      );
    } catch (error) {
      lifecycle.emitError(error);
      throw error;
    }
  };
  // StreamFn exposes iteration and its final result, not provider implementation methods.
  return {
    [Symbol.asyncIterator]: observedIterator,
    result: observedResult,
  };
}

export function wrapStreamFnWithDiagnosticModelCallEvents(
  streamFn: StreamFn,
  ctx: ModelCallDiagnosticContext,
): StreamFn {
  const measurePromptStats = createModelPromptStats();
  return (
    model: Parameters<StreamFn>[0] & Pick<ProviderRuntimeModel, "requestTimeoutMs">,
    streamContext,
    options,
  ) => {
    const requestTimeoutMs = clampPositiveTimerTimeoutMs(
      model.requestTimeoutMs ?? ctx.requestTimeoutMs,
    );
    const lifecycle = createModelLifecycle({
      ctx,
      options,
      requestTimeoutMs,
      createObserver: (capturePromptStats, captureByteStats) =>
        createModelObserver({
          diagnosticOwner: ctx.diagnosticOwner,
          streamContext,
          contentCapture: ctx.contentCapture,
          suppressPluginHooks: ctx.suppressPluginHooks,
          capturePromptStats,
          captureByteStats,
          measurePromptStats,
        }),
    });

    try {
      const result = lifecycle.runInTransportContext(() =>
        streamFn(model, streamContext, lifecycle.propagatedOptions),
      );
      if (isPromiseLike(result)) {
        return result
          .then((resolved) => observeModelCallStream(resolved, lifecycle))
          .catch((err: unknown) => throwModelCallError(lifecycle, err));
      }
      return observeModelCallStream(result, lifecycle);
    } catch (err) {
      return throwModelCallError(lifecycle, err);
    }
  };
}
