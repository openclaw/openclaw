import type { FallbackOnErrorCodes } from "../config/types.agents-shared.js";
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

function findErrorProperty<T>(
  err: unknown,
  reader: (candidate: unknown) => T | undefined,
  seen: Set<object> = new Set(),
): T | undefined {
  const direct = reader(err);
  if (direct !== undefined) {
    return direct;
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  if (seen.has(err)) {
    return undefined;
  }
  seen.add(err);
  const candidate = err as { error?: unknown; cause?: unknown };
  return (
    findErrorProperty(candidate.error, reader, seen) ??
    findErrorProperty(candidate.cause, reader, seen)
  );
}

function readDirectStatusCode(err: unknown): number | undefined {
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

function getStatusCode(err: unknown): number | undefined {
  return findErrorProperty(err, readDirectStatusCode);
}

function readDirectErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const directCode = (err as { code?: unknown }).code;
  if (typeof directCode === "string") {
    const trimmed = directCode.trim();
    return trimmed ? trimmed : undefined;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "string" || /^\d+$/.test(status)) {
    return undefined;
  }
  const trimmed = status.trim();
  return trimmed ? trimmed : undefined;
}

function getErrorCode(err: unknown): string | undefined {
  return findErrorProperty(err, readDirectErrorCode);
}

function readDirectErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.message || undefined;
  }
  if (typeof err === "string") {
    return err || undefined;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    return err.description ?? undefined;
  }
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message || undefined;
    }
  }
  return undefined;
}

function getErrorMessage(err: unknown): string {
  return findErrorProperty(err, readDirectErrorMessage) ?? "";
}

function getErrorCause(err: unknown): unknown {
  if (!err || typeof err !== "object" || !("cause" in err)) {
    return undefined;
  }
  return (err as { cause?: unknown }).cause;
}

/** Classify rate-limit / overloaded from symbolic error codes like RESOURCE_EXHAUSTED. */
function classifyFailoverReasonFromSymbolicCode(raw: string | undefined): FailoverReason | null {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  switch (normalized) {
    case "RESOURCE_EXHAUSTED":
    case "RATE_LIMIT":
    case "RATE_LIMITED":
    case "RATE_LIMIT_EXCEEDED":
    case "TOO_MANY_REQUESTS":
    case "THROTTLED":
    case "THROTTLING":
    case "THROTTLINGEXCEPTION":
    case "THROTTLING_EXCEPTION":
      return "rate_limit";
    case "OVERLOADED":
    case "OVERLOADED_ERROR":
      return "overloaded";
    default:
      return null;
  }
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

  // Check symbolic error codes (e.g. RESOURCE_EXHAUSTED from Google APIs)
  const symbolicCodeReason = classifyFailoverReasonFromSymbolicCode(getErrorCode(err));
  if (symbolicCodeReason) {
    return symbolicCodeReason;
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
      "EHOSTDOWN",
      "ENETRESET",
      "EPIPE",
      "EAI_AGAIN",
    ].includes(code)
  ) {
    return "timeout";
  }
  // Walk into error cause chain *before* timeout heuristics so that a specific
  // cause (e.g. RESOURCE_EXHAUSTED wrapped in AbortError) overrides a parent
  // message-based "timeout" guess from isTimeoutError.
  const cause = getErrorCause(err);
  if (cause && cause !== err) {
    const causeReason = resolveFailoverReasonFromError(cause);
    if (causeReason) {
      return causeReason;
    }
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

  return new FailoverError(message, {
    reason,
    provider: context?.provider,
    model: context?.model,
    profileId: context?.profileId,
    status,
    code,
    cause: err instanceof Error ? err : undefined,
  });
}

/**
 * Default HTTP status codes that trigger fallback.
 * - Server errors: 500, 502, 503, 504
 * - Rate limits: 429
 * - Timeouts: 408
 * - Not found: 404 (model may have been removed)
 */
const DEFAULT_FALLBACK_STATUS_CODES = [408, 429, 500, 502, 503, 504, 404];

/**
 * Check if an error should trigger fallback based on the configured error codes.
 *
 * @param err - The error to check
 * @param fallbackOnErrors - Configuration for which errors should trigger fallback
 *   - "default": Use default behavior (server errors + rate limits + timeout + not found)
 *   - "all": All HTTP errors (4xx and 5xx) trigger fallback
 *   - number[]: Custom list of status codes
 * @returns true if the error should trigger fallback
 */
export function shouldTriggerFallback(
  err: unknown,
  fallbackOnErrors?: FallbackOnErrorCodes,
): boolean {
  const status = getStatusCode(err);

  // If no status code found, try to determine from error reason
  if (status === undefined) {
    const reason = resolveFailoverReasonFromError(err);
    // For any mode, only trigger fallback if we have a recognized failover reason
    // This prevents unrelated runtime errors (parse errors, filesystem errors) from triggering fallback
    return reason !== null;
  }

  // Determine if status code should trigger fallback
  if (fallbackOnErrors === undefined || fallbackOnErrors === "default") {
    return DEFAULT_FALLBACK_STATUS_CODES.includes(status);
  } else if (fallbackOnErrors === "all") {
    // "all" means all HTTP errors (4xx and 5xx)
    return status >= 400;
  } else {
    // Custom list of status codes
    return fallbackOnErrors.includes(status);
  }
}

/**
 * Coerce an error to FailoverError if it should trigger fallback based on configuration.
 *
 * @param err - The error to check
 * @param fallbackOnErrors - Configuration for which errors should trigger fallback
 * @param context - Additional context (provider, model, profileId)
 * @returns FailoverError if the error should trigger fallback, null otherwise
 */
export function coerceToFailoverErrorWithConfig(
  err: unknown,
  fallbackOnErrors: FallbackOnErrorCodes | undefined,
  context?: {
    provider?: string;
    model?: string;
    profileId?: string;
  },
): FailoverError | null {
  // First check if it's already a FailoverError
  if (isFailoverError(err)) {
    // Still need to check if it should trigger fallback based on config
    if (!shouldTriggerFallback(err, fallbackOnErrors)) {
      return null;
    }
    return err;
  }

  // Check if error should trigger fallback
  if (!shouldTriggerFallback(err, fallbackOnErrors)) {
    return null;
  }

  // Coerce to FailoverError
  const status = getStatusCode(err);
  const reason = resolveFailoverReasonFromError(err);
  const message = getErrorMessage(err) || String(err);
  const code = getErrorCode(err);

  // If we have a status but no reason, create a generic reason
  const effectiveReason: FailoverReason = reason ?? "unknown";

  return new FailoverError(message, {
    reason: effectiveReason,
    provider: context?.provider,
    model: context?.model,
    profileId: context?.profileId,
    status,
    code,
    cause: err instanceof Error ? err : undefined,
  });
}
