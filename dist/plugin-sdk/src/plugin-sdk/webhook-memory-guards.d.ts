export type FixedWindowRateLimiter = {
    isRateLimited: (key: string, nowMs?: number) => boolean;
    size: () => number;
    clear: () => void;
};
export type BoundedCounter = {
    increment: (key: string, nowMs?: number) => number;
    size: () => number;
    clear: () => void;
};
export declare const WEBHOOK_RATE_LIMIT_DEFAULTS: Readonly<{
    windowMs: 60000;
    maxRequests: 120;
    maxTrackedKeys: 4096;
}>;
export declare const WEBHOOK_ANOMALY_COUNTER_DEFAULTS: Readonly<{
    maxTrackedKeys: 4096;
    ttlMs: number;
    logEvery: 25;
}>;
export declare const WEBHOOK_ANOMALY_STATUS_CODES: readonly number[];
export type WebhookAnomalyTracker = {
    record: (params: {
        key: string;
        statusCode: number;
        message: (count: number) => string;
        log?: (message: string) => void;
        nowMs?: number;
    }) => number;
    size: () => number;
    clear: () => void;
};
/** Create a simple fixed-window rate limiter for in-memory webhook protection. */
export declare function createFixedWindowRateLimiter(options: {
    windowMs: number;
    maxRequests: number;
    maxTrackedKeys: number;
    pruneIntervalMs?: number;
}): FixedWindowRateLimiter;
/** Count keyed events in memory with optional TTL pruning and bounded cardinality. */
export declare function createBoundedCounter(options: {
    maxTrackedKeys: number;
    ttlMs?: number;
    pruneIntervalMs?: number;
}): BoundedCounter;
/** Track repeated webhook failures and emit sampled logs for suspicious request patterns. */
export declare function createWebhookAnomalyTracker(options?: {
    maxTrackedKeys?: number;
    ttlMs?: number;
    logEvery?: number;
    trackedStatusCodes?: readonly number[];
}): WebhookAnomalyTracker;
