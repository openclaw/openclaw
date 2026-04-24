import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  emitDiagnosticEvent,
  type DiagnosticEventInput,
} from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";

type ModelCallDiagnosticContext = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  trace: DiagnosticTraceContext;
  nextCallId: () => string;
};

type ModelCallEventBase = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "type"
>;

export function diagnosticErrorCategory(err: unknown): string {
  if (err instanceof Error && err.name.trim()) {
    return err.name;
  }
  return typeof err;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function baseModelCallEvent(
  ctx: ModelCallDiagnosticContext,
  callId: string,
  trace: DiagnosticTraceContext,
): ModelCallEventBase {
  return {
    runId: ctx.runId,
    callId,
    ...(ctx.sessionKey && { sessionKey: ctx.sessionKey }),
    ...(ctx.sessionId && { sessionId: ctx.sessionId }),
    provider: ctx.provider,
    model: ctx.model,
    ...(ctx.api && { api: ctx.api }),
    ...(ctx.transport && { transport: ctx.transport }),
    trace,
  };
}

async function* observeModelCallIterator<T>(
  iterator: AsyncIterator<T>,
  eventBase: ModelCallEventBase,
  startedAt: number,
): AsyncIterable<T> {
  let terminalEmitted = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      yield next.value;
    }
    terminalEmitted = true;
    emitDiagnosticEvent({
      type: "model.call.completed",
      ...eventBase,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    terminalEmitted = true;
    emitDiagnosticEvent({
      type: "model.call.error",
      ...eventBase,
      durationMs: Date.now() - startedAt,
      errorCategory: diagnosticErrorCategory(err),
    });
    throw err;
  } finally {
    if (!terminalEmitted) {
      await iterator.return?.();
      emitDiagnosticEvent({
        type: "model.call.error",
        ...eventBase,
        durationMs: Date.now() - startedAt,
        errorCategory: "StreamAbandoned",
      });
    }
  }
}

function observeModelCallStream<T extends AsyncIterable<unknown>>(
  stream: T,
  eventBase: ModelCallEventBase,
  startedAt: number,
): T {
  const createIterator = stream[Symbol.asyncIterator].bind(stream);
  Object.defineProperty(stream, Symbol.asyncIterator, {
    configurable: true,
    value: () =>
      observeModelCallIterator(createIterator(), eventBase, startedAt)[Symbol.asyncIterator](),
  });
  return stream;
}

function observeModelCallResult(
  result: unknown,
  eventBase: ModelCallEventBase,
  startedAt: number,
): unknown {
  if (isAsyncIterable(result)) {
    return observeModelCallStream(result, eventBase, startedAt);
  }
  emitDiagnosticEvent({
    type: "model.call.completed",
    ...eventBase,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

export function wrapStreamFnWithDiagnosticModelCallEvents(
  streamFn: StreamFn,
  ctx: ModelCallDiagnosticContext,
): StreamFn {
  return ((model, streamContext, options) => {
    const callId = ctx.nextCallId();
    const trace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace));
    const eventBase = baseModelCallEvent(ctx, callId, trace);
    emitDiagnosticEvent({
      type: "model.call.started",
      ...eventBase,
    });
    const startedAt = Date.now();

    try {
      const result = streamFn(model, streamContext, options);
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => observeModelCallResult(resolved, eventBase, startedAt),
          (err) => {
            emitDiagnosticEvent({
              type: "model.call.error",
              ...eventBase,
              durationMs: Date.now() - startedAt,
              errorCategory: diagnosticErrorCategory(err),
            });
            throw err;
          },
        );
      }
      return observeModelCallResult(result, eventBase, startedAt);
    } catch (err) {
      emitDiagnosticEvent({
        type: "model.call.error",
        ...eventBase,
        durationMs: Date.now() - startedAt,
        errorCategory: diagnosticErrorCategory(err),
      });
      throw err;
    }
  }) as StreamFn;
}
