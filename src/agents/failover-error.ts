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

function getStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // Dig into nested `err.error` shapes (e.g. Google Vertex abort wrappers)
  const nestedError =
    "error" in err && err.error && typeof err.error === "object"
      ? (err.error as { status?: unknown; code?: unknown })
      : undefined;
  const candidate =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode ??
    nestedError?.code ??
    nestedError?.status;
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
  const nestedError =
    "error" in err && err.error && typeof err.error === "object"
      ? (err.error as { code?: unknown; status?: unknown })
      : undefined;
  const candidate = (err as { code?: unknown }).code ?? nestedError?.status ?? nestedError?.code;
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
    // Extract message from nested `err.error.message` (e.g. Google Vertex wrappers)
    const nestedMessage =
      "error" in err &&
      err.error &&
      typeof err.error === "object" &&
      typeof (err.error as { message?: unknown }).message === "string"
        ? ((err.error as { message: string }).message ?? "")
        : "";
    if (nestedMessage) {
      return nestedMessage;
    }
  }
  return "";
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
  if (isTimeoutError(err)) {
    return "timeout";
  }
  // Walk into error cause chain (e.g. AbortError wrapping a rate-limit cause)
  const cause = getErrorCause(err);
  if (cause && cause !== err) {
    const causeReason = resolveFailoverReasonFromError(cause);
    if (causeReason) {
      return causeReason;
    }
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
