import { bindAbortRelay } from "../utils/fetch-timeout.js";
function throwAbortError() {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
}
/**
 * Checks if an object is a valid AbortSignal using structural typing.
 * This is more reliable than `instanceof` across different realms (VM, iframe, etc.)
 * where the AbortSignal constructor may differ.
 */
function isAbortSignal(obj) {
    return obj instanceof AbortSignal;
}
function combineAbortSignals(a, b) {
    if (!a && !b) {
        return undefined;
    }
    if (a && !b) {
        return a;
    }
    if (b && !a) {
        return b;
    }
    if (a?.aborted) {
        return a;
    }
    if (b?.aborted) {
        return b;
    }
    if (typeof AbortSignal.any === "function" && isAbortSignal(a) && isAbortSignal(b)) {
        return AbortSignal.any([a, b]);
    }
    const controller = new AbortController();
    const onAbort = bindAbortRelay(controller);
    a?.addEventListener("abort", onAbort, { once: true });
    b?.addEventListener("abort", onAbort, { once: true });
    return controller.signal;
}
export function wrapToolWithAbortSignal(tool, abortSignal) {
    if (!abortSignal) {
        return tool;
    }
    const execute = tool.execute;
    if (!execute) {
        return tool;
    }
    return {
        ...tool,
        execute: async (toolCallId, params, signal, onUpdate) => {
            const combined = combineAbortSignals(signal, abortSignal);
            if (combined?.aborted) {
                throwAbortError();
            }
            return await execute(toolCallId, params, combined, onUpdate);
        },
    };
}
