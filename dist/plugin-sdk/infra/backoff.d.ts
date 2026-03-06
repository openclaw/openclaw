export type BackoffPolicy = {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
};
export declare function computeBackoff(policy: BackoffPolicy, attempt: number): number;
export declare function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void>;
