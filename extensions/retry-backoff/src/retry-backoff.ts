/**
 * Retryable-failure backoff logic for model fallback.
 *
 * Extracted from src/agents/model-fallback.ts on the dev branch.
 * This module provides the retry constants and pure helper functions
 * without modifying core files.
 */

/**
 * Reasons that qualify for automatic retry-with-backoff.
 * - rate_limit: explicit 429 / cooldown skip
 * - timeout:    request hung (commonly a silent rate limit from proxies)
 * - unknown:    no classifiable reason — often a timeout with empty error body
 */
export const RETRYABLE_REASONS = new Set<string>(["rate_limit", "timeout", "unknown"]);

export type RetryConfig = {
  /** Maximum number of retry rounds (default: 2). */
  maxRounds: number;
  /** Base delay in ms (actual = base × 2^round, default: 15000). */
  baseDelayMs: number;
  /** Hard ceiling for any single retry delay (default: 60000). */
  maxDelayMs: number;
};

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRounds: 2,
  baseDelayMs: 15_000,
  maxDelayMs: 60_000,
};

/**
 * Compute the delay for a given retry round with exponential backoff.
 */
export function computeRetryDelay(round: number, config?: Partial<RetryConfig>): number {
  const base = config?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs;
  const max = config?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs;
  return Math.min(base * 2 ** round, max);
}

/**
 * Determine whether a failed round should be retried.
 *
 * Accepts either a single reason string or an array of attempt objects.
 * Returns true if all reasons are retryable and round < maxRounds.
 */
export function isRetryableRound(
  reasonOrAttempts: string | Array<{ reason?: string }>,
  round: number,
  config?: Partial<RetryConfig>,
): boolean {
  const maxRounds = config?.maxRounds ?? DEFAULT_RETRY_CONFIG.maxRounds;
  if (round >= maxRounds) {
    return false;
  }

  if (typeof reasonOrAttempts === "string") {
    return RETRYABLE_REASONS.has(reasonOrAttempts);
  }

  if (reasonOrAttempts.length === 0) {
    return false;
  }
  return reasonOrAttempts.every((a) => RETRYABLE_REASONS.has(a.reason ?? "unknown"));
}

/**
 * Sleep helper for retry delays.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Retryable Error Classification ────────────────────────────────────────

/**
 * A model/API error with structured classification.
 */
export type ClassifiedError = Error & {
  /** HTTP status code, if available. */
  status?: number;
  /** Retry-After header value in milliseconds, if the server sent one. */
  retryAfterMs?: number;
  /** Classified failure reason. */
  reason?: string;
};

/**
 * Classify an unknown error into a retryable reason.
 * Returns the reason string or `undefined` if not retryable.
 */
export function classifyError(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;

  const e = err as Record<string, unknown>;

  // Explicit reason from upstream
  if (typeof e.reason === "string" && RETRYABLE_REASONS.has(e.reason)) {
    return e.reason;
  }

  // HTTP 429 → rate_limit
  if (e.status === 429 || e.statusCode === 429) {
    return "rate_limit";
  }

  // HTTP 408, 504, 502, 503 → timeout/overloaded
  const status = (e.status ?? e.statusCode) as number | undefined;
  if (status && [408, 502, 503, 504].includes(status)) {
    return "timeout";
  }

  // Timeout-like error messages
  const msg = (e.message as string) ?? "";
  if (/timeout|timed?\s*out|ECONNRESET|ETIMEDOUT|ECONNABORTED/i.test(msg)) {
    return "timeout";
  }

  return undefined;
}

/**
 * Extract `Retry-After` in milliseconds from an error or response.
 * Handles both seconds (number) and HTTP-date formats.
 */
export function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;

  const e = err as Record<string, unknown>;

  // Already parsed
  if (typeof e.retryAfterMs === "number" && e.retryAfterMs > 0) {
    return e.retryAfterMs;
  }

  // Raw Retry-After header value
  const raw = e.retryAfter ?? (e.headers as Record<string, unknown>)?.["retry-after"];
  if (raw == null) return undefined;

  if (typeof raw === "number") {
    return raw * 1000; // seconds → ms
  }
  if (typeof raw === "string") {
    const secs = Number(raw);
    if (!Number.isNaN(secs)) {
      return secs * 1000;
    }
    // Try HTTP-date
    const date = new Date(raw).getTime();
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return undefined;
}

// ─── High-level Retry Executor ─────────────────────────────────────────────

export type RetryWithBackoffOptions = {
  /** Retry config overrides. */
  config?: Partial<RetryConfig>;
  /** Optional AbortSignal to cancel retries early. */
  signal?: AbortSignal;
  /** Optional callback invoked before each retry sleep. */
  onRetry?: (info: { round: number; reason: string; delayMs: number; error: unknown }) => void;
};

/**
 * Execute `fn` with automatic retry on retryable errors (429, timeout, unknown).
 *
 * - Classifies errors via `classifyError()`
 * - Respects `Retry-After` headers (uses the larger of Retry-After and computed backoff)
 * - Exponential back-off with configurable base/max delay
 * - Non-retryable errors are thrown immediately
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts?: RetryWithBackoffOptions,
): Promise<T> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...opts?.config };
  let round = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      opts?.signal?.throwIfAborted();

      const reason = classifyError(err);
      if (!reason || round >= config.maxRounds) {
        throw err;
      }

      // Compute delay: max of exponential backoff and Retry-After
      const expDelay = computeRetryDelay(round, config);
      const retryAfter = extractRetryAfterMs(err);
      const delayMs = retryAfter != null ? Math.min(Math.max(retryAfter, expDelay), config.maxDelayMs) : expDelay;

      opts?.onRetry?.({ round, reason, delayMs, error: err });

      await sleep(delayMs);
      round++;
    }
  }
}
