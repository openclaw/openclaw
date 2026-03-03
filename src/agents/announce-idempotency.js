export function buildAnnounceIdFromChildRun(params) {
    return `v1:${params.childSessionKey}:${params.childRunId}`;
}
export function buildAnnounceIdempotencyKey(announceId) {
    return `announce:${announceId}`;
}
export function resolveQueueAnnounceId(params) {
    const announceId = params.announceId?.trim();
    if (announceId) {
        return announceId;
    }
    // Backward-compatible fallback for queue items that predate announceId.
    return `legacy:${params.sessionKey}:${params.enqueuedAt}`;
}
