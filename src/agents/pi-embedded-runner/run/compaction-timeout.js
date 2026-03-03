export function shouldFlagCompactionTimeout(signal) {
    if (!signal.isTimeout) {
        return false;
    }
    return signal.isCompactionPendingOrRetrying || signal.isCompactionInFlight;
}
export function selectCompactionTimeoutSnapshot(params) {
    if (!params.timedOutDuringCompaction) {
        return {
            messagesSnapshot: params.currentSnapshot,
            sessionIdUsed: params.currentSessionId,
            source: "current",
        };
    }
    if (params.preCompactionSnapshot) {
        return {
            messagesSnapshot: params.preCompactionSnapshot,
            sessionIdUsed: params.preCompactionSessionId,
            source: "pre-compaction",
        };
    }
    return {
        messagesSnapshot: params.currentSnapshot,
        sessionIdUsed: params.currentSessionId,
        source: "current",
    };
}
