import { RateLimitError } from "@buape/carbon";
import {
  createRateLimitRetryRunner,
  type RetryConfig,
  type RetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

export const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
} satisfies RetryConfig;

export const DISCORD_TRANSIENT_RE =
  /502|503|timeout|timed?.?out|connect|reset|closed|unavailable|temporarily|fetch.failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket.hang.up/i;

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  return createRateLimitRetryRunner({
    ...params,
    defaults: DISCORD_RETRY_DEFAULTS,
    logLabel: "discord",
    shouldRetry: (err) =>
      err instanceof RateLimitError || DISCORD_TRANSIENT_RE.test(formatErrorMessage(err)),
    retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
  });
}
