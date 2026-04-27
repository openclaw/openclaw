import { fireAndForgetBoundedHook } from "../../../hooks/fire-and-forget.js";
import { diagnosticErrorCategory, diagnosticProviderRequestIdHash, } from "../../../infra/diagnostic-error-metadata.js";
import { emitTrustedDiagnosticEvent, } from "../../../infra/diagnostic-events.js";
import { createChildDiagnosticTraceContext, freezeDiagnosticTraceContext, } from "../../../infra/diagnostic-trace-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
export { diagnosticErrorCategory };
const MODEL_CALL_STREAM_RETURN_TIMEOUT_MS = 1000;
function isPromiseLike(value) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return false;
    }
    try {
        return typeof value.then === "function";
    }
    catch {
        return false;
    }
}
function asyncIteratorFactory(value) {
    if (value === null || typeof value !== "object") {
        return undefined;
    }
    try {
        const asyncIterator = value[Symbol.asyncIterator];
        if (typeof asyncIterator !== "function") {
            return undefined;
        }
        return () => asyncIterator.call(value);
    }
    catch {
        return undefined;
    }
}
function baseModelCallEvent(ctx, callId, trace) {
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
function modelCallErrorFields(err) {
    const upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);
    return {
        errorCategory: diagnosticErrorCategory(err),
        ...(upstreamRequestIdHash ? { upstreamRequestIdHash } : {}),
    };
}
function modelCallHookEventBase(eventBase) {
    return {
        runId: eventBase.runId,
        callId: eventBase.callId,
        ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
        ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
        provider: eventBase.provider,
        model: eventBase.model,
        ...(eventBase.api ? { api: eventBase.api } : {}),
        ...(eventBase.transport ? { transport: eventBase.transport } : {}),
    };
}
function modelCallHookContext(eventBase) {
    return Object.freeze({
        runId: eventBase.runId,
        trace: eventBase.trace,
        ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
        ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
        modelProviderId: eventBase.provider,
        modelId: eventBase.model,
    });
}
function dispatchModelCallStartedHook(eventBase) {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("model_call_started")) {
        return;
    }
    const event = Object.freeze(modelCallHookEventBase(eventBase));
    const hookCtx = modelCallHookContext(eventBase);
    fireAndForgetBoundedHook(() => hookRunner.runModelCallStarted(event, hookCtx), "model_call_started plugin hook failed");
}
function dispatchModelCallEndedHook(eventBase, fields) {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("model_call_ended")) {
        return;
    }
    const event = Object.freeze({
        ...modelCallHookEventBase(eventBase),
        ...fields,
    });
    const hookCtx = modelCallHookContext(eventBase);
    fireAndForgetBoundedHook(() => hookRunner.runModelCallEnded(event, hookCtx), "model_call_ended plugin hook failed");
}
function emitModelCallStarted(eventBase) {
    emitTrustedDiagnosticEvent({
        type: "model.call.started",
        ...eventBase,
    });
    dispatchModelCallStartedHook(eventBase);
}
function emitModelCallCompleted(eventBase, startedAt) {
    const durationMs = Date.now() - startedAt;
    emitTrustedDiagnosticEvent({
        type: "model.call.completed",
        ...eventBase,
        durationMs,
    });
    dispatchModelCallEndedHook(eventBase, {
        durationMs,
        outcome: "completed",
    });
}
function emitModelCallError(eventBase, startedAt, fields) {
    const durationMs = Date.now() - startedAt;
    emitTrustedDiagnosticEvent({
        type: "model.call.error",
        ...eventBase,
        durationMs,
        ...fields,
    });
    dispatchModelCallEndedHook(eventBase, {
        durationMs,
        outcome: "error",
        ...fields,
    });
}
async function safeReturnIterator(iterator) {
    let returnResult;
    try {
        returnResult = iterator.return?.();
    }
    catch {
        return;
    }
    if (!returnResult) {
        return;
    }
    let timeout;
    try {
        await Promise.race([
            Promise.resolve(returnResult).catch(() => undefined),
            new Promise((resolve) => {
                timeout = setTimeout(resolve, MODEL_CALL_STREAM_RETURN_TIMEOUT_MS);
                const unref = typeof timeout === "object" && timeout
                    ? timeout.unref
                    : undefined;
                if (unref) {
                    unref.call(timeout);
                }
            }),
        ]);
    }
    finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}
async function* observeModelCallIterator(iterator, eventBase, startedAt) {
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
        emitModelCallCompleted(eventBase, startedAt);
    }
    catch (err) {
        terminalEmitted = true;
        emitModelCallError(eventBase, startedAt, modelCallErrorFields(err));
        throw err;
    }
    finally {
        if (!terminalEmitted) {
            await safeReturnIterator(iterator);
            emitModelCallError(eventBase, startedAt, { errorCategory: "StreamAbandoned" });
        }
    }
}
function observeModelCallStream(stream, createIterator, eventBase, startedAt) {
    const observedIterator = () => observeModelCallIterator(createIterator(), eventBase, startedAt)[Symbol.asyncIterator]();
    let hasNonConfigurableIterator = false;
    try {
        hasNonConfigurableIterator =
            Object.getOwnPropertyDescriptor(stream, Symbol.asyncIterator)?.configurable === false;
    }
    catch {
        hasNonConfigurableIterator = true;
    }
    if (hasNonConfigurableIterator) {
        return {
            [Symbol.asyncIterator]: observedIterator,
        };
    }
    return new Proxy(stream, {
        get(target, property, receiver) {
            if (property === Symbol.asyncIterator) {
                return observedIterator;
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
function observeModelCallResult(result, eventBase, startedAt) {
    const createIterator = asyncIteratorFactory(result);
    if (createIterator) {
        return observeModelCallStream(result, createIterator, eventBase, startedAt);
    }
    emitModelCallCompleted(eventBase, startedAt);
    return result;
}
export function wrapStreamFnWithDiagnosticModelCallEvents(streamFn, ctx) {
    return ((model, streamContext, options) => {
        const callId = ctx.nextCallId();
        const trace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace));
        const eventBase = baseModelCallEvent(ctx, callId, trace);
        emitModelCallStarted(eventBase);
        const startedAt = Date.now();
        try {
            const result = streamFn(model, streamContext, options);
            if (isPromiseLike(result)) {
                return result.then((resolved) => observeModelCallResult(resolved, eventBase, startedAt), (err) => {
                    emitModelCallError(eventBase, startedAt, modelCallErrorFields(err));
                    throw err;
                });
            }
            return observeModelCallResult(result, eventBase, startedAt);
        }
        catch (err) {
            emitModelCallError(eventBase, startedAt, modelCallErrorFields(err));
            throw err;
        }
    });
}
