import { retryAsync } from "../../infra/retry.js";

export interface LlmRetryConfig {
  /**
   * Max retry attempts for LLM calls (default: 7).
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
}

const DEFAULT_RETRY_CONFIG = {
  attempts: 7,
  minDelayMs: 1000,
  maxDelayMs: 32000,
  jitter: 0.1,
};

/**
 * Check if an error is retryable for LLM calls.
 */
export function isRetryableLlmError(err: unknown): boolean {
  if (!err) {
    return false;
  }

  const errorObj = err as { status?: number; code?: string; message?: string };
  const status = errorObj.status;
  const message = errorObj.message ?? "";

  // Retry on rate limit (429)
  if (status === 429) {
    return true;
  }

  // Retry on server errors (500, 502, 503, 504)
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  // Retry on network errors
  const code = (errorObj.code ?? "").toUpperCase();
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "ECONNABORTED"].includes(code)) {
    return true;
  }

  // Retry on timeout errors
  if (/timeout|timed out|deadline exceeded/i.test(message)) {
    return true;
  }

  // Do not retry on client errors (400, 401, 403, 404)
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return false;
  }

  // Do not retry on billing errors (402)
  if (status === 402) {
    return false;
  }

  // Default: do not retry unknown errors
  return false;
}

/**
 * Extract retry-after delay from error response headers or body.
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
  const retryInMatch = message.match(/retry in ([0-9.]+)(?:ms|seconds?|secs?|s)/i);
  if (retryInMatch?.[1]) {
    const value = parseFloat(retryInMatch[1]);
    if (Number.isFinite(value) && value > 0) {
      return value * 1000;
    }
  }

  const resetAfterMatch = message.match(/reset after ([0-9.]+)(?:ms|seconds?|secs?|s)/i);
  if (resetAfterMatch?.[1]) {
    const value = parseFloat(resetAfterMatch[1]);
    if (Number.isFinite(value) && value > 0) {
      return value * 1000;
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
