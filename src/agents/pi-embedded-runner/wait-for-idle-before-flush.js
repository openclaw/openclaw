export const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30000;
async function waitForAgentIdleBestEffort(agent, timeoutMs) {
    const waitForIdle = agent?.waitForIdle;
    if (typeof waitForIdle !== "function") {
        return;
    }
    let timeoutHandle;
    try {
        await Promise.race([
            waitForIdle.call(agent),
            new Promise((resolve) => {
                timeoutHandle = setTimeout(resolve, timeoutMs);
                timeoutHandle.unref?.();
            }),
        ]);
    }
    catch {
        // Best-effort during cleanup.
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
export async function flushPendingToolResultsAfterIdle(opts) {
    await waitForAgentIdleBestEffort(opts.agent, opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);
    opts.sessionManager?.flushPendingToolResults?.();
}
