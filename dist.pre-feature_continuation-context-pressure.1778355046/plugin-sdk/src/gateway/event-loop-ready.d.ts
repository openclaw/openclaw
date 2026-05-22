export type EventLoopReadyResult = {
    ready: boolean;
    elapsedMs: number;
    maxDriftMs: number;
    checks: number;
    aborted: boolean;
};
type EventLoopReadyOptions = {
    maxWaitMs?: number;
    intervalMs?: number;
    driftThresholdMs?: number;
    consecutiveReadyChecks?: number;
    signal?: AbortSignal;
};
export declare function waitForEventLoopReady(options?: EventLoopReadyOptions): Promise<EventLoopReadyResult>;
export {};
