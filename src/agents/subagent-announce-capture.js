export async function readLatestSubagentOutputWithRetryUsing(params) {
    const maxWaitMs = Math.max(0, Math.min(params.maxWaitMs, 15_000));
    let waitedMs = 0;
    let result;
    while (waitedMs < maxWaitMs) {
        result = await params.readSubagentOutput(params.sessionKey, params.outcome);
        if (result?.trim()) {
            return result;
        }
        const remainingMs = maxWaitMs - waitedMs;
        if (remainingMs <= 0) {
            break;
        }
        const sleepMs = Math.min(params.retryIntervalMs, remainingMs);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        waitedMs += sleepMs;
    }
    return result;
}
export async function captureSubagentCompletionReplyUsing(params) {
    const immediate = await params.readSubagentOutput(params.sessionKey);
    if (immediate?.trim()) {
        return immediate;
    }
    if (params.waitForReply === false) {
        return undefined;
    }
    return await readLatestSubagentOutputWithRetryUsing({
        sessionKey: params.sessionKey,
        maxWaitMs: params.maxWaitMs,
        retryIntervalMs: params.retryIntervalMs,
        readSubagentOutput: params.readSubagentOutput,
    });
}
