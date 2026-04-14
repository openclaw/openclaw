import { readErrorName } from "../infra/errors.js";
import { isTimeoutErrorMessage, type FailoverReason } from "./pi-embedded-helpers.js";
import {
  classifyFailoverSignal,
  type FailoverClassification,
  type FailoverSignal,
} from "./pi-embedded-helpers/errors.js";
import {
  resolveTransportUpstreamRequestId,
  resolveTransportUpstreamRequestIdFromHeaders,
} from "./transport-stream-shared.js";

const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;
const UPSTREAM_REQUEST_ID_PATTERNS = [
  /\b(?:x-request-id|request-id|request_id|trace-id|trace_id)\s*[:=]\s*([a-zA-Z0-9._:-]+)/i,
  /\((?:request_id|trace_id)\s*:\s*([a-zA-Z0-9._:-]+)\)/i,
] as const;

export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
  readonly code?: string;
  readonly upstreamRequestId?: string;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      profileId?: string;
      status?: number;
      code?: string;
      upstreamRequestId?: string;
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
    this.upstreamRequestId = params.upstreamRequestId;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  if (err instanceof FailoverError) {
    return true;
  }
  return Boolean(
    err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "FailoverError" &&
    typeof (err as { reason?: unknown }).reason === "string",
  );
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

function readDirectUpstreamRequestId(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as {
    upstreamRequestId?: unknown;
    request_id?: unknown;
    requestId?: unknown;
    _request_id?: unknown;
    trace_id?: unknown;
    traceId?: unknown;
    headers?: Headers | Record<string, unknown>;
    response?: {
      headers?: Headers | Record<string, unknown>;
      request_id?: unknown;
      requestId?: unknown;
      _request_id?: unknown;
      trace_id?: unknown;
      traceId?: unknown;
    };
  };
  return resolveTransportUpstreamRequestId(
    candidate.upstreamRequestId,
    candidate.request_id,
    candidate.requestId,
    candidate._request_id,
    candidate.trace_id,
    candidate.traceId,
    resolveTransportUpstreamRequestIdFromHeaders(candidate.headers),
    resolveTransportUpstreamRequestIdFromHeaders(candidate.response?.headers),
    candidate.response?.request_id,
    candidate.response?.requestId,
    candidate.response?._request_id,
    candidate.response?.trace_id,
    candidate.response?.traceId,
  );
}

function getUpstreamRequestId(err: unknown): string | undefined {
  const direct = findErrorProperty(err, readDirectUpstreamRequestId);
  if (direct) {
    return direct;
  }
  const message = getErrorMessage(err);
  for (const pattern of UPSTREAM_REQUEST_ID_PATTERNS) {
    const matched = message.match(pattern);
    const id = resolveTransportUpstreamRequestId(matched?.[1]);
    if (id) {
      return id;
    }
  }
  return undefined;
}

function readDirectProvider(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const provider = (err as { provider?: unknown }).provider;
  if (typeof provider !== "string") {
    return undefined;
  }
  const trimmed = provider.trim();
  return trimmed || undefined;
}

function getProvider(err: unknown): string | undefined {
  return findErrorProperty(err, readDirectProvider);
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

function failoverReasonFromClassification(
  classification: FailoverClassification | null,
): FailoverReason | null {
  return classification?.kind === "reason" ? classification.reason : null;
}

function normalizeErrorSignal(err: unknown): FailoverSignal {
  const message = getErrorMessage(err);
  return {
    status: getStatusCode(err),
    code: getErrorCode(err),
    message: message || undefined,
    provider: getProvider(err),
  };
}

function resolveFailoverClassificationFromError(err: unknown): FailoverClassification | null {
  if (isFailoverError(err)) {
    return {
      kind: "reason",
      reason: err.reason,
    };
  }

  const classification = classifyFailoverSignal(normalizeErrorSignal(err));
  if (!classification || classification.kind === "context_overflow") {
    // Let wrapped causes override parent timeout/overflow guesses.
    const cause = getErrorCause(err);
    if (cause && cause !== err) {
      const causeClassification = resolveFailoverClassificationFromError(cause);
      if (causeClassification) {
        return causeClassification;
      }
    }
  }

  if (classification) {
    return classification;
  }

  if (isTimeoutError(err)) {
    return {
      kind: "reason",
      reason: "timeout",
    };
  }
  return null;
}

export function resolveFailoverReasonFromError(err: unknown): FailoverReason | null {
  return failoverReasonFromClassification(resolveFailoverClassificationFromError(err));
}

export function describeFailoverError(err: unknown): {
  message: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
  upstreamRequestId?: string;
} {
  if (isFailoverError(err)) {
    return {
      message: err.message,
      reason: err.reason,
      status: err.status,
      code: err.code,
      upstreamRequestId: err.upstreamRequestId,
    };
  }
  const signal = normalizeErrorSignal(err);
  const message = signal.message ?? String(err);
  return {
    message,
    reason: resolveFailoverReasonFromError(err) ?? undefined,
    status: signal.status,
    code: signal.code,
    upstreamRequestId: getUpstreamRequestId(err),
  };
}

export function coerceToFailoverError(
  err: unknown,
  context?: {
    provider?: string;
    model?: string;
    profileId?: string;
    upstreamRequestId?: string;
  },
): FailoverError | null {
  if (isFailoverError(err)) {
    return err;
  }
  const reason = resolveFailoverReasonFromError(err);
  if (!reason) {
    return null;
  }

  const signal = normalizeErrorSignal(err);
  const message = signal.message ?? String(err);
  const status = signal.status ?? resolveFailoverStatus(reason);
  const code = signal.code;
  const upstreamRequestId = getUpstreamRequestId(err) ?? context?.upstreamRequestId;

  return new FailoverError(message, {
    reason,
    provider: context?.provider,
    model: context?.model,
    profileId: context?.profileId,
    status,
    code,
    upstreamRequestId,
    cause: err instanceof Error ? err : undefined,
  });
}
