export function mapQueueOutcomeToDeliveryResult(outcome) {
    if (outcome === "steered") {
        return {
            delivered: true,
            path: "steered",
        };
    }
    if (outcome === "queued") {
        return {
            delivered: true,
            path: "queued",
        };
    }
    return {
        delivered: false,
        path: "none",
    };
}
export async function runSubagentAnnounceDispatch(params) {
    const phases = [];
    const appendPhase = (phase, result) => {
        phases.push({
            phase,
            delivered: result.delivered,
            path: result.path,
            error: result.error,
        });
    };
    const withPhases = (result) => ({
        ...result,
        phases,
    });
    if (params.signal?.aborted) {
        return withPhases({
            delivered: false,
            path: "none",
        });
    }
    if (!params.expectsCompletionMessage) {
        const primaryQueueOutcome = await params.queue();
        const primaryQueue = mapQueueOutcomeToDeliveryResult(primaryQueueOutcome);
        appendPhase("queue-primary", primaryQueue);
        if (primaryQueue.delivered) {
            return withPhases(primaryQueue);
        }
        if (primaryQueueOutcome === "dropped") {
            return withPhases(primaryQueue);
        }
        const primaryDirect = await params.direct();
        appendPhase("direct-primary", primaryDirect);
        return withPhases(primaryDirect);
    }
    const primaryDirect = await params.direct();
    appendPhase("direct-primary", primaryDirect);
    if (primaryDirect.delivered) {
        return withPhases(primaryDirect);
    }
    if (params.signal?.aborted) {
        return withPhases(primaryDirect);
    }
    const fallbackQueueOutcome = await params.queue();
    const fallbackQueue = mapQueueOutcomeToDeliveryResult(fallbackQueueOutcome);
    appendPhase("queue-fallback", fallbackQueue);
    if (fallbackQueue.delivered) {
        return withPhases(fallbackQueue);
    }
    return withPhases(primaryDirect);
}
