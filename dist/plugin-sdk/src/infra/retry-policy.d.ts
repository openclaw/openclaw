import { type RetryConfig } from "./retry.js";
export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;
export declare const CHANNEL_API_RETRY_DEFAULTS: {
    attempts: number;
    minDelayMs: number;
    maxDelayMs: number;
    jitter: number;
};
export declare function createRateLimitRetryRunner(params: {
    retry?: RetryConfig;
    configRetry?: RetryConfig;
    verbose?: boolean;
    defaults: Required<RetryConfig>;
    logLabel: string;
    shouldRetry: (err: unknown) => boolean;
    retryAfterMs?: (err: unknown) => number | undefined;
}): RetryRunner;
export declare function createChannelApiRetryRunner(params: {
    retry?: RetryConfig;
    configRetry?: RetryConfig;
    verbose?: boolean;
    shouldRetry?: (err: unknown) => boolean;
    /**
     * When true, the custom shouldRetry predicate is used exclusively —
     * the default channel API fallback regex is NOT OR'd in.
     * Use this for non-idempotent operations (e.g. sendMessage) where
     * the regex fallback would cause duplicate message delivery.
     */
    strictShouldRetry?: boolean;
}): RetryRunner;
