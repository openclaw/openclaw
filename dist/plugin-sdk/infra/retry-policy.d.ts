import { type RetryConfig } from "./retry.js";
export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;
export declare const DISCORD_RETRY_DEFAULTS: {
    attempts: number;
    minDelayMs: number;
    maxDelayMs: number;
    jitter: number;
};
export declare const TELEGRAM_RETRY_DEFAULTS: {
    attempts: number;
    minDelayMs: number;
    maxDelayMs: number;
    jitter: number;
};
export declare function createDiscordRetryRunner(params: {
    retry?: RetryConfig;
    configRetry?: RetryConfig;
    verbose?: boolean;
}): RetryRunner;
export declare function createTelegramRetryRunner(params: {
    retry?: RetryConfig;
    configRetry?: RetryConfig;
    verbose?: boolean;
    shouldRetry?: (err: unknown) => boolean;
    /**
     * When true, the custom shouldRetry predicate is used exclusively —
     * the default TELEGRAM_RETRY_RE fallback regex is NOT OR'd in.
     * Use this for non-idempotent operations (e.g. sendMessage) where
     * the regex fallback would cause duplicate message delivery.
     */
    strictShouldRetry?: boolean;
}): RetryRunner;
