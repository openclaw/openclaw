export function buildEmbeddedSubscriptionParams(params) {
    return params;
}
export async function cleanupEmbeddedAttemptResources(params) {
    try {
        try {
            params.removeToolResultContextGuard?.();
        }
        catch {
            /* best-effort */
        }
        try {
            await params.flushPendingToolResultsAfterIdle({
                agent: params.session?.agent,
                sessionManager: params.sessionManager,
                clearPendingOnTimeout: true,
            });
        }
        catch {
            /* best-effort */
        }
        try {
            params.session?.dispose();
        }
        catch {
            /* best-effort */
        }
        try {
            params.releaseWsSession(params.sessionId, { allowPool: params.allowWsSessionPool === true });
        }
        catch {
            /* best-effort */
        }
        try {
            await params.bundleMcpRuntime?.dispose();
        }
        catch {
            /* best-effort */
        }
        try {
            await params.bundleLspRuntime?.dispose();
        }
        catch {
            /* best-effort */
        }
    }
    finally {
        await params.sessionLock.release();
    }
}
