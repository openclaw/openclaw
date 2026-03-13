export type RetryConfig = {
    attempts?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
};
export type RetryInfo = {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    err: unknown;
    label?: string;
};
export type RetryOptions = RetryConfig & {
    label?: string;
    shouldRetry?: (err: unknown, attempt: number) => boolean;
    retryAfterMs?: (err: unknown) => number | undefined;
    onRetry?: (info: RetryInfo) => void;
};
export declare function resolveRetryConfig(defaults?: Required<RetryConfig>, overrides?: RetryConfig): Required<RetryConfig>;
export declare function retryAsync<T>(fn: () => Promise<T>, attemptsOrOptions?: number | RetryOptions, initialDelayMs?: number): Promise<T>;
