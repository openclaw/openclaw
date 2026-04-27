export const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;
async function waitForAgentIdleBestEffort(agent, timeoutMs) {
    const waitForIdle = agent?.waitForIdle;
    if (typeof waitForIdle !== "function") {
        return false;
    }
    const idleResolved = Symbol("idle");
    const idleTimedOut = Symbol("timeout");
    let timeoutHandle;
    try {
        const outcome = await Promise.race([
            waitForIdle.call(agent).then(() => idleResolved),
            new Promise((resolve) => {
                timeoutHandle = setTimeout(() => resolve(idleTimedOut), timeoutMs);
                timeoutHandle.unref?.();
            }),
        ]);
        return outcome === idleTimedOut;
    }
    catch {
        // Best-effort during cleanup.
        return false;
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
export async function flushPendingToolResultsAfterIdle(opts) {
    const timedOut = await waitForAgentIdleBestEffort(opts.agent, opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);
    if (timedOut && opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
        opts.sessionManager.clearPendingToolResults();
        return;
    }
    opts.sessionManager?.flushPendingToolResults?.();
}
