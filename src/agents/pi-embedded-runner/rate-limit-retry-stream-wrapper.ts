import type { StreamFn } from "@mariozechner/pi-agent-core";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";

const RATE_LIMIT_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

/** Maximum number of retries before surfacing the 429 error. */
const MAX_RETRIES = 3;

/** Cap server-provided Retry-After to prevent unbounded blocking. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Detect whether an error represents an HTTP 429 (rate limit) response.
 *
 * Provider SDK error shapes vary, so we check:
 *  - `err.status === 429`  (OpenAI SDK, Anthropic SDK)
 *  - `err.statusCode === 429 | "429"`  (some providers use string codes)
 *  - `err.response?.status === 429`  (Axios-style wrappers)
 */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const obj = err as Record<string, unknown>;
  if (obj.status === 429 || obj.statusCode === 429 || obj.statusCode === "429") {
    return true;
  }
  const response = obj.response;
  if (
    response &&
    typeof response === "object" &&
    (response as Record<string, unknown>).status === 429
  ) {
    return true;
  }
  return false;
}

/**
 * Extract the raw `retry-after` string from a headers-like object.
 *
 * Handles plain objects (`{ "retry-after": "5" }`) and `Headers` instances
 * (which require `.get("retry-after")`).
 */
function getRetryAfterRaw(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  // Headers instance (Fetch API / SDK wrappers)
  if (typeof (headers as { get?: unknown }).get === "function") {
    const val = (headers as { get(name: string): string | null }).get("retry-after");
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  // Plain record
  const val = (headers as Record<string, unknown>)["retry-after"];
  if (typeof val === "string" && val.length > 0) {
    return val;
  }
  return undefined;
}

/**
 * Parse the `Retry-After` header value from an error, if present.
 *
 * Checks `err.headers` (Anthropic/OpenAI SDK) and `err.response.headers`
 * (Axios-style wrappers). Supports both delta-seconds (`Retry-After: 5`)
 * and HTTP-date (`Retry-After: Sun, 09 Mar 2026 15:00:10 GMT`) per
 * RFC 7231 §7.1.3.
 *
 * Returns the delay in milliseconds, or `undefined` if absent/unparseable.
 */
function parseRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const obj = err as Record<string, unknown>;
  // Try err.headers first, then err.response.headers (Axios-style).
  const raw =
    getRetryAfterRaw(obj.headers) ??
    getRetryAfterRaw(
      obj.response && typeof obj.response === "object"
        ? (obj.response as Record<string, unknown>).headers
        : undefined,
    );
  if (!raw) {
    return undefined;
  }
  // Try delta-seconds first (most common).
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  // Try HTTP-date.
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    const delta = date.getTime() - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Wrap a `StreamFn` to transparently retry on HTTP 429 (rate limit) errors.
 *
 * Applied to **all** providers at the stream-call boundary in `attempt.ts`.
 * Retries up to `MAX_RETRIES` times with exponential backoff, honoring the
 * `Retry-After` header when present.
 */
export function createRateLimitRetryStreamWrapper(
  baseStreamFn: StreamFn,
  abortSignal?: AbortSignal,
): StreamFn {
  return (model, context, options) => {
    const attempt = async (retryCount: number): Promise<Awaited<ReturnType<StreamFn>>> => {
      try {
        const result = baseStreamFn(model, context, options);
        // StreamFn can return either sync (EventStream) or async (Promise<EventStream>).
        return await result;
      } catch (err) {
        if (!isRateLimitError(err) || retryCount >= MAX_RETRIES) {
          throw err;
        }
        if (abortSignal?.aborted) {
          throw err;
        }
        const retryAfterMs = parseRetryAfterMs(err);
        const backoffMs = computeBackoff(RATE_LIMIT_RETRY_POLICY, retryCount + 1);
        // backoffMs is already bounded by computeBackoff; cap Retry-After separately
        // so an unreasonably large header cannot block indefinitely.
        const delayMs =
          retryAfterMs != null ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : backoffMs;
        await sleepWithAbort(delayMs, abortSignal);
        return attempt(retryCount + 1);
      }
    };
    return attempt(0);
  };
}
