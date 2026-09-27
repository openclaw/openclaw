import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { captureAsyncWorkTracker } from "../../../shared/async-work-scope.js";
import type { StreamFn } from "../../runtime/index.js";
import {
  createModelLifecycle,
  type ModelCallDiagnosticContext,
  type ModelCallLifecycle,
} from "./attempt.model-diagnostic-lifecycle.js";
import { createModelObserver } from "./attempt.model-diagnostic-observation.js";

const MODEL_CALL_STREAM_RETURN_TIMEOUT_MS = 1000;
function asyncIteratorFactory(value: unknown): (() => AsyncIterator<unknown>) | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const asyncIterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
    if (typeof asyncIterator !== "function") {
      return undefined;
    }
    return () => asyncIterator.call(value) as AsyncIterator<unknown>;
  } catch {
    return undefined;
  }
}

async function safeReturnIterator(
  iterator: AsyncIterator<unknown>,
  trackCleanup: ReturnType<typeof captureAsyncWorkTracker>,
): Promise<void> {
  const returnResult = trackCleanup(() => iterator.return?.());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Early consumer return should not hang diagnostic completion forever; give
    // provider cleanup a short chance, then emit completion for the observed call.
    await Promise.race([
      Promise.resolve(returnResult).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, MODEL_CALL_STREAM_RETURN_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function observeModelCallIterator<T>(
  iterator: AsyncIterator<T>,
  lifecycle: ModelCallLifecycle,
  observeSharedResult: (() => Promise<unknown>) | undefined,
): AsyncIterableIterator<T> {
  const trackCleanup = captureAsyncWorkTracker();
  let started = false;
  let returning: Promise<IteratorResult<T>> | undefined;
  const observed = observe();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (returning) {
        return returning.then(() => ({ done: true as const, value: undefined }));
      }
      started = true;
      return observed.next();
    },
    return(value) {
      returning ??= started
        ? observed.return(value)
        : Promise.resolve().then(async () => {
            // An unopened async generator skips its finally block. Forward closure
            // explicitly so inner stream owners can settle their admitted repairs.
            await safeReturnIterator(iterator, trackCleanup);
            lifecycle.emitCompleted();
            return { done: true as const, value };
          });
      return returning;
    },
    throw(error) {
      started = true;
      return observed.throw(error);
    },
  };

  async function* observe(): AsyncGenerator<T> {
    // Tracks whether the underlying iterator terminated on its own (done or threw).
    // This is independent of state.terminalEventEmitted: result() can emit the
    // terminal event first, but the abandoned iterator still needs return() cleanup.
    let iteratorSettled = false;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          iteratorSettled = true;
          break;
        }
        const chunk = next.value;
        lifecycle.observer.observeResponseChunk(lifecycle.startedAt, chunk);
        lifecycle.observer.maybeEmitStreamProgress(lifecycle.eventBase);
        yield chunk;
      }
      // EOF can precede result decorators' settlement. Retain that work through
      // owner cleanup without delaying drain-only consumers or losing failures.
      if (observeSharedResult && !lifecycle.observer.state.terminalError) {
        void trackCleanup(observeSharedResult).catch(() => undefined);
      } else {
        lifecycle.emitCompleted();
      }
    } catch (err) {
      iteratorSettled = true;
      lifecycle.emitError(err);
      throw err;
    } finally {
      if (!iteratorSettled) {
        // A consumer can stop reading before the provider emits done/error — e.g.
        // the agent loop returns on the terminal event after awaiting result().
        // Close the underlying iterator for provider cleanup (idle-timeout abort
        // listeners, SSE readers) even when result() already emitted the terminal
        // event; lifecycle completion self-dedupes via state.terminalEventEmitted.
        await safeReturnIterator(iterator, trackCleanup);
        lifecycle.emitCompleted();
      }
    }
  }
}

function createSharedResultObserver(
  stream: unknown,
  lifecycle: ModelCallLifecycle,
): (() => Promise<unknown>) | undefined {
  if (!isRecord(stream) || typeof stream.result !== "function") {
    return undefined;
  }
  const resultFn = stream.result;
  // The stream contract exposes one no-argument final result. Share observation
  // across iterator exhaustion and explicit callers, including rejected results.
  let cached: Promise<unknown> | undefined;
  return () => {
    if (!cached) {
      cached = Promise.resolve()
        .then(() => resultFn.call(stream))
        .then(
          (resolved) => {
            lifecycle.observer.observeFinalResult(
              lifecycle.eventBase,
              lifecycle.startedAt,
              resolved,
            );
            lifecycle.emitCompleted();
            return resolved;
          },
          (err: unknown) => {
            lifecycle.emitError(err);
            throw err;
          },
        );
      // Drain-only consumers never await this promise; retain rejection for callers.
      void cached.catch(() => undefined);
    }
    return cached;
  };
}

function observeModelCallStream(
  stream: AsyncIterable<unknown>,
  createIterator: () => AsyncIterator<unknown>,
  lifecycle: ModelCallLifecycle,
): AsyncIterable<unknown> {
  const observedResult = createSharedResultObserver(stream, lifecycle);
  const observedIterator = () =>
    observeModelCallIterator(createIterator(), lifecycle, observedResult);
  let hasNonConfigurableIterator;
  try {
    hasNonConfigurableIterator =
      Object.getOwnPropertyDescriptor(stream, Symbol.asyncIterator)?.configurable === false;
  } catch {
    hasNonConfigurableIterator = true;
  }
  if (hasNonConfigurableIterator) {
    return {
      [Symbol.asyncIterator]: observedIterator,
      ...(observedResult ? { result: observedResult } : {}),
    };
  }
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      if (property === "result" && observedResult) {
        return observedResult;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeModelCallResult(result: unknown, lifecycle: ModelCallLifecycle): unknown {
  const createIterator = asyncIteratorFactory(result);
  if (createIterator) {
    return observeModelCallStream(result as AsyncIterable<unknown>, createIterator, lifecycle);
  }
  lifecycle.emitCompleted();
  return result;
}

/**
 * Wraps a model stream function with diagnostic model-call lifecycle events,
 * traceparent propagation, request/response byte accounting, optional captured
 * model content, progress heartbeats, and plugin hook dispatch.
 */
export function wrapStreamFnWithDiagnosticModelCallEvents(
  streamFn: StreamFn,
  ctx: ModelCallDiagnosticContext,
): StreamFn {
  return ((model, streamContext, options) => {
    const requestTimeoutMs = clampPositiveTimerTimeoutMs(
      (isRecord(model) ? model.requestTimeoutMs : undefined) ?? ctx.requestTimeoutMs,
    );
    const lifecycle = createModelLifecycle({
      ctx,
      options,
      requestTimeoutMs,
      createObserver: (capturePromptStats) =>
        createModelObserver({
          config: ctx.config,
          streamContext,
          contentCapture: ctx.contentCapture,
          suppressPluginHooks: ctx.suppressPluginHooks,
          capturePromptStats,
        }),
    });

    try {
      const result = streamFn(model, streamContext, lifecycle.propagatedOptions);
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => observeModelCallResult(resolved, lifecycle),
          (err: unknown) => {
            lifecycle.emitError(err);
            throw err;
          },
        );
      }
      return observeModelCallResult(result, lifecycle);
    } catch (err) {
      lifecycle.emitError(err);
      throw err;
    }
  }) as StreamFn;
}
