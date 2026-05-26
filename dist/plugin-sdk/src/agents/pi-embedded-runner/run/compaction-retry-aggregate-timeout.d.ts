/**
 * Wait for compaction retry completion with an aggregate timeout to avoid
 * holding a session lane indefinitely when retry resolution is lost.
 */
export declare function waitForCompactionRetryWithAggregateTimeout(params: {
    waitForCompactionRetry: () => Promise<void>;
    abortable: <T>(promise: Promise<T>) => Promise<T>;
    aggregateTimeoutMs: number;
    onTimeout?: () => void;
    isCompactionStillInFlight?: () => boolean;
}): Promise<{
    timedOut: boolean;
}>;
