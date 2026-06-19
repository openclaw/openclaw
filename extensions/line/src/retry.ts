// Retry logic for LINE API calls
import { sleep } from "openclaw/plugin-sdk/runtime-env";

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

export type IsRetryableFn = (error: unknown, attempt: number) => boolean;

/**
 * Determine if an error is retryable.
 * - 5xx: retry
 * - 429 with "rate limit": retry with backoff
 * - 429 with "monthly limit": don't retry (quota exhausted)
 * - 400 with "reply token": don't retry (token expired)
 * - Other 4xx: don't retry
 * - Network/timeout errors: retry
 */
export function isRetryableError(error: unknown, _attempt: number): boolean {
  if (error && typeof error === "object") {
    // @line/bot-sdk v11 HTTPFetchError: { status, statusText, body: string }
    // Some internal callers may pass { statusCode, statusMessage, body: string }.
    const httpErr = error as { status?: number; statusCode?: number; body?: string };
    const status = httpErr.status ?? httpErr.statusCode;
    const body = httpErr.body ?? "";
    const msg = typeof body === "string" ? body : "";

    if (status && status >= 500 && status < 600) return true;
    if (status === 429) {
      if (msg.includes("monthly limit")) return false;
      if (msg.includes("rate limit")) return true;
      return true; // unknown 429 → backoff
    }
    if (status === 400 && msg.includes("reply token")) return false;
    if (status && status >= 400 && status < 500) return false;
  }
  return true; // network/timeout: retry
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY,
  retryable: IsRetryableFn = isRetryableError,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < config.maxRetries && retryable(err, attempt)) {
        const delay = Math.min(config.baseDelayMs * Math.pow(2, attempt), config.maxDelayMs);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}
