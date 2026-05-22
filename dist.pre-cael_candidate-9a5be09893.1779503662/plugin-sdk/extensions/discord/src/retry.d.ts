import { type RetryConfig, type RetryRunner } from "openclaw/plugin-sdk/retry-runtime";
export declare function isRetryableDiscordTransientError(err: unknown): boolean;
export declare function createDiscordRetryRunner(params: {
    retry?: RetryConfig;
    configRetry?: RetryConfig;
    verbose?: boolean;
}): RetryRunner;
