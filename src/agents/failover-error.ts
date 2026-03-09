import { readErrorName } from "../infra/errors.js";
import {
  classifyFailoverReason,
  classifyFailoverReasonFromHttpStatus,
  isTimeoutErrorMessage,
  type FailoverReason,
} from "./pi-embedded-helpers.js";

const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;

export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
  readonly code?: string;
  /** Server-provided retry delay in milliseconds (from Retry-After header). */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      profileId?: string;
      status?: number;
      code?: string;
      cause?: unknown;
      retryAfterMs?: number;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.profileId = params.profileId;
    this.status = params.status;
    this.code = params.code;
    this.retryAfterMs = params.retryAfterMs;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

export function resolveFailoverStatus(reason: FailoverReason): number | undefined {
  switch (reason) {
    case "billing":
      return 402;
    case "rate_limit":
      return 429;
    case "overloaded":
      return 503;
    case "auth":
      return 401;
    case "auth_permanent":
      return 403;
    case "timeout":
      return 408;
    case "format":
      return 400;
    case "model_not_found":
      return 404;
    case "session_expired":
      return 410; // Gone - session no longer exists
    default:
      return undefined;
  }
}

function getStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number") {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = (err as { code?: unknown }).code;
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  return trimmed ? trimmed : undefined;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    return err.description ?? "";
  }
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}

function hasTimeoutHint(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (readErrorName(err) === "TimeoutError") {
    return true;
  }
  const message = getErrorMessage(err);
  return Boolean(message && isTimeoutErrorMessage(message));
}

export function isTimeoutError(err: unknown): boolean {
  if (hasTimeoutHint(err)) {
    return true;
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  if (readErrorName(err) !== "AbortError") {
    return false;
  }
  const message = getErrorMessage(err);
  if (message && ABORT_TIMEOUT_RE.test(message)) {
    return true;
  }
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  const reason = "reason" in err ? (err as { reason?: unknown }).reason : undefined;
  return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}

export function resolveFailoverReasonFromError(err: unknown): FailoverReason | null {
  if (isFailoverError(err)) {
    return err.reason;
  }

  const status = getStatusCode(err);
  const message = getErrorMessage(err);
  const statusReason = classifyFailoverReasonFromHttpStatus(status, message);
  if (statusReason) {
    return statusReason;
  }

  const code = (getErrorCode(err) ?? "").toUpperCase();
  if (
    [
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ECONNRESET",
      "ECONNABORTED",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENETRESET",
      "EAI_AGAIN",
    ].includes(code)
  ) {
    return "timeout";
  }
  if (isTimeoutError(err)) {
    return "timeout";
  }
  if (!message) {
    return null;
  }
  return classifyFailoverReason(message);
}

export function describeFailoverError(err: unknown): {
  message: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
} {
  if (isFailoverError(err)) {
    return {
      message: err.message,
      reason: err.reason,
      status: err.status,
      code: err.code,
    };
  }
  const message = getErrorMessage(err) || String(err);
  return {
    message,
    reason: resolveFailoverReasonFromError(err) ?? undefined,
    status: getStatusCode(err),
    code: getErrorCode(err),
  };
}

/**
 * Extract a Retry-After delay (in milliseconds) from an error object.
 * Tries multiple strategies:
 * 1. `err.headers["retry-after"]` or `err.headers.get("retry-after")` (HTTP response)
 * 2. `err.retry_after` or `err.retryAfter` (SDK-specific)
 * 3. Regex match in error message (e.g. "retry after 30 seconds")
 * Returns `null` when no Retry-After information can be extracted.
 */
export function parseRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") {
    return null;
  }

  // Strategy 1: headers object (Anthropic/OpenAI SDK errors often expose .headers)
  const headers = (err as { headers?: unknown }).headers;
  if (headers) {
    let raw: string | null | undefined;
    if (typeof headers === "object" && headers !== null) {
      if (typeof (headers as { get?: unknown }).get === "function") {
        raw = (headers as { get(key: string): string | null }).get("retry-after");
      } else {
        const candidate =
          (headers as Record<string, unknown>)["retry-after"] ??
          (headers as Record<string, unknown>)["Retry-After"];
        raw = typeof candidate === "string" ? candidate : null;
      }
    }
    if (typeof raw === "string") {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.ceil(seconds * 1000);
      }
      // HTTP-date format
      const dateMs = Date.parse(raw);
      if (Number.isFinite(dateMs)) {
        const delayMs = dateMs - Date.now();
        if (delayMs > 0) {
          return delayMs;
        }
      }
    }
  }

  // Strategy 2: SDK fields
  const retryAfter =
    (err as { retry_after?: unknown }).retry_after ?? (err as { retryAfter?: unknown }).retryAfter;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter * 1000);
  }

  // Strategy 3: error message pattern "retry after N seconds" / "try again in N seconds"
  const message = getErrorMessage(err);
  if (message) {
    const match = message.match(
      /(?:retry|try again)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:ond)?s?)?)?/i,
    );
    if (match?.[1]) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.ceil(seconds * 1000);
      }
    }
  }

  // Walk into cause
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === "object") {
    return parseRetryAfterMs(cause);
  }

  return null;
}

export function coerceToFailoverError(
  err: unknown,
  context?: {
    provider?: string;
    model?: string;
    profileId?: string;
  },
): FailoverError | null {
  if (isFailoverError(err)) {
    return err;
  }
  const reason = resolveFailoverReasonFromError(err);
  if (!reason) {
    return null;
  }

  const message = getErrorMessage(err) || String(err);
  const status = getStatusCode(err) ?? resolveFailoverStatus(reason);
  const code = getErrorCode(err);
  const retryAfterMs = parseRetryAfterMs(err) ?? undefined;

  return new FailoverError(message, {
    reason,
    provider: context?.provider,
    model: context?.model,
    profileId: context?.profileId,
    status,
    code,
    cause: err instanceof Error ? err : undefined,
    retryAfterMs,
  });
}
