import { RateLimitError } from "@buape/carbon";
import {
  createRateLimitRetryRunner,
  formatErrorMessage,
  type RetryConfig,
  type RetryRunner,
} from "openclaw/plugin-sdk/infra-runtime";

// Matches transient HTTP and network errors that are safe to retry.
// Mirrors the pattern used by the Telegram retry policy.
const DISCORD_TRANSIENT_RE =
  /429|502|503|timeout|connect|reset|closed|unavailable|temporarily|fetch.failed/i;

export const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
} satisfies RetryConfig;

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
