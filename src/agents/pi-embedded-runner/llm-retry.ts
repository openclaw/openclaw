import { retryAsync } from "../../infra/retry.js";

export interface LlmRetryConfig {
  /**
   * Maximum total attempts for LLM calls, including the initial call.
   * For example, 7 means 1 initial attempt plus up to 6 retries (default: 7).
   */
  attempts?: number;

  /**
   * Minimum retry delay in ms (default: 1000).
   */
  minDelayMs?: number;

  /**
   * Maximum retry delay cap in ms (default: 32000).
   */
  maxDelayMs?: number;

  /**
   * Jitter factor (0-1) to randomize retry delays (default: 0.1).
   */
  jitter?: number;

  /**
   * Optional AbortSignal to cancel retry attempts.
   */
  signal?: AbortSignal;
}

const DEFAULT_RETRY_CONFIG = {
  attempts: 7,
  minDelayMs: 1000,
  maxDelayMs: 32000,
  jitter: 0.1,
};

/**
 * Check if an error is retryable for LLM calls.
 *
 * @remarks
 * This function checks the error's HTTP status code, error code, and message to determine
 * whether it should be retried. The logic is:
 * - Do not retry on client errors (4xx) except 429 (rate limit)
 * - Do not retry on billing errors (402)
 * - Retry on rate limit (429)
 * - Retry on server errors (5xx)
 * - Retry on network errors (ETIMEDOUT, ESOCKETTIMEDOUT, ECONNRESET, ECONNABORTED)
 * - Retry on timeout errors (only when not a 4xx status code)
 *
 * @param err - The error to check, which may be an object with status, statusCode, code, or message properties.
 * @returns `true` if the error is retryable, `false` otherwise.
 */
export function isRetryableLlmError(err: unknown): boolean {
  if (!err) {
    return false;
  }

  const errorObj = err as { status?: number; statusCode?: number; code?: string; message?: string };
  const status = errorObj.status ?? errorObj.statusCode;
  const message = errorObj.message ?? "";

  // Check status codes first (more reliable than message parsing)
  // Do not retry on client errors (400, 401, 403, 404, 408)
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 408) {
    return false;
  }

  // Do not retry on billing errors (402)
  if (status === 402) {
    return false;
  }

  // Retry on rate limit (429)
  if (status === 429) {
    return true;
  }

  // Retry on server errors (500, 502, 503, 504)
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  // Only check timeout message if there's no 4xx status code
  // (timeout messages in 4xx responses indicate client-side timeouts that shouldn't be retried)
  const is4xx = status !== undefined && status >= 400 && status < 500;
  if (!is4xx) {
    // Retry on timeout errors (only for non-4xx status codes)
    if (/timeout|timed out|deadline exceeded|deadline_exceeded/i.test(message)) {
      return true;
    }

    // Retry on network errors
    const code = (errorObj.code ?? "").toUpperCase();
    if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "ECONNABORTED"].includes(code)) {
      return true;
    }
  }

  // Default: do not retry unknown errors
  return false;
}

/**
 * Extract retry-after delay from error response headers or body.
 *
 * @remarks
 * This function checks the error's headers and message for retry delay hints:
 * - `Retry-After` header (RFC 7231, in seconds)
 * - `x-ratelimit-reset` header (Unix timestamp, converted to relative ms)
 * - `x-ratelimit-reset-after` header (seconds)
 * - Message patterns like "retry in 5s" or "reset after 100ms"
 *
 * @param err - The error to check, which may have headers and/or message properties.
 * @returns The retry delay in milliseconds, or `undefined` if no delay is found.
 */
export function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }

  const errorObj = err as {
    status?: number;
    headers?: { get?: (name: string) => string | null };
    message?: string;
  };

  // Check headers for Retry-After
  if (errorObj.headers && typeof errorObj.headers.get === "function") {
    const retryAfter = errorObj.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }

    // Check for rate limit reset headers
    const rateLimitReset = errorObj.headers.get("x-ratelimit-reset");
    if (rateLimitReset) {
      const resetSeconds = Number.parseInt(rateLimitReset, 10);
      if (!Number.isNaN(resetSeconds)) {
        return Math.max(0, resetSeconds * 1000 - Date.now());
      }
    }

    const rateLimitResetAfter = errorObj.headers.get("x-ratelimit-reset-after");
    if (rateLimitResetAfter) {
      const resetAfterSeconds = Number(rateLimitResetAfter);
      if (Number.isFinite(resetAfterSeconds)) {
        return resetAfterSeconds * 1000;
      }
    }
  }

  // Check error message for retry delay hints
  const message = errorObj.message ?? "";
  const retryInMatch = message.match(
    /retry\s+in\s+([0-9.]+)\s*(ms|milliseconds?|seconds?|secs?|s)?/i,
  );
  if (retryInMatch?.[1]) {
    const value = parseFloat(retryInMatch[1]);
    const unit = (retryInMatch[2] ?? "s").toLowerCase();
    if (Number.isFinite(value) && value > 0) {
      return unit === "ms" || unit.startsWith("millisec") ? value : value * 1000;
    }
  }

  const resetAfterMatch = message.match(
    /reset\s+after\s+([0-9.]+)\s*(ms|milliseconds?|seconds?|secs?|s)?/i,
  );
  if (resetAfterMatch?.[1]) {
    const value = parseFloat(resetAfterMatch[1]);
    const unit = (resetAfterMatch[2] ?? "s").toLowerCase();
    if (Number.isFinite(value) && value > 0) {
      return unit === "ms" || unit.startsWith("millisec") ? value : value * 1000;
    }
  }

  return undefined;
}

/**
 * Wrap a prompt call with LLM retry logic.
 */
export function withLlmRetry<T>(fn: () => Promise<T>, config?: LlmRetryConfig): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };

  return retryAsync(fn, {
    attempts: cfg.attempts,
    minDelayMs: cfg.minDelayMs,
    maxDelayMs: cfg.maxDelayMs,
    jitter: cfg.jitter,
    shouldRetry: (err: unknown) => isRetryableLlmError(err),
    retryAfterMs: (err: unknown) => extractRetryAfterMs(err),
    onRetry: (info) => {
      console.warn(
        `[LLM Retry] Attempt ${info.attempt}/${info.maxAttempts}, ` +
          `waiting ${info.delayMs}ms before retry. Error: ${String(info.err)}`,
      );
    },
  });
}
