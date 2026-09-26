// Error identity and timeout recognition must not load logging or provider runtime.
import { readErrorName } from "@openclaw/normalization-core/error-coercion";
import {
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentRunTerminalOutcome } from "../agent-run-terminal-outcome.types.js";
import { isProviderRequestSizeCeilingError, isTimeoutErrorMessage } from "./message-patterns.js";
import type { FailoverReason } from "./signal.js";

const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;

export type CliTimeoutContext = {
  mode: "overall" | "no-output";
  timeoutSeconds: number;
  observedActivity: boolean;
  activeToolCount: number;
  backgroundTaskCount: number;
  /** Native compaction (or similar backend maintenance) is running: silent but busy. */
  compactionActive?: boolean;
};

export type FallbackAttemptRecord = {
  provider: string;
  model: string;
  reason: FailoverReason;
  status?: number;
  error?: string;
};

/** Structured error used to carry model fallback/failover metadata across layers. */
export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly authMode?: string;
  readonly status?: number;
  readonly code?: string;
  readonly rawError?: string;
  // Preserve the provider fact before the message becomes user-facing copy.
  readonly requestSizeCeiling: boolean;
  readonly authProfileFailure?: { allInCooldown: boolean };
  // Preserve request attribution through exhausted-failover wrappers.
  readonly sessionId?: string;
  readonly lane?: string;
  readonly suspend?: boolean;
  readonly cliTimeout?: CliTimeoutContext;
  // Actual timeout presence is independent of both its phase and the retry category.
  readonly timeout?: Pick<AgentRunTerminalOutcome, "timeoutPhase" | "providerStarted">;
  readonly attempts?: readonly FallbackAttemptRecord[];
  readonly soonestCooldownExpiry?: number | null;

  constructor(
    message: string,
    params: Omit<FailoverError, keyof Error | "requestSizeCeiling"> & { cause?: unknown },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.profileId = params.profileId;
    this.authMode = params.authMode;
    this.status = params.status;
    this.code = params.code;
    this.rawError = params.rawError;
    this.requestSizeCeiling = isProviderRequestSizeCeilingError(params.rawError ?? message);
    this.authProfileFailure = params.authProfileFailure;
    this.sessionId = params.sessionId;
    this.lane = params.lane;
    this.suspend = params.suspend;
    this.cliTimeout = params.cliTimeout;
    this.timeout = params.timeout;
    this.attempts = params.attempts;
    this.soonestCooldownExpiry = params.soonestCooldownExpiry;
  }
}

/** Return true for native or serialized failover errors. */
export function isFailoverError(err: unknown): err is FailoverError {
  if (err instanceof FailoverError) {
    return true;
  }
  const candidate = asOptionalObjectRecord(err);
  return candidate?.name === "FailoverError" && typeof candidate.reason === "string";
}

export function findErrorProperty<T>(
  err: unknown,
  reader: (candidate: unknown) => T | undefined,
  seen: Set<object> = new Set(),
): T | undefined {
  const direct = reader(err);
  if (direct !== undefined) {
    return direct;
  }
  const candidate = asOptionalObjectRecord(err);
  if (!candidate || seen.has(candidate)) {
    return undefined;
  }
  seen.add(candidate);
  return (
    findErrorProperty(candidate.error, reader, seen) ??
    findErrorProperty(candidate.cause, reader, seen)
  );
}

export function readDirectErrorCode(err: unknown): string | undefined {
  const candidate = asOptionalObjectRecord(err);
  if (!candidate) {
    return undefined;
  }
  const directCode = candidate.code;
  if (typeof directCode === "string") {
    return normalizeOptionalString(directCode);
  }
  // SAFETY: Optional chaining handles absent details; only string codes are accepted.
  const detailCode = (candidate.detail as { code?: unknown } | undefined)?.code;
  if (typeof detailCode === "string") {
    return normalizeOptionalString(detailCode);
  }
  const status = candidate.status;
  if (typeof status !== "string" || /^\d+$/.test(status)) {
    return undefined;
  }
  return normalizeOptionalString(status);
}

export function getFailoverErrorCode(err: unknown): string | undefined {
  // A typed failure owns its code, including absence; only raw errors search causes.
  return isFailoverError(err) ? err.code : findErrorProperty(err, readDirectErrorCode);
}

export function readDirectErrorMessage(err: unknown): string | undefined {
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
  return readStringField(asOptionalObjectRecord(err), "message") || undefined;
}

export function getErrorMessage(err: unknown): string {
  return findErrorProperty(err, readDirectErrorMessage) ?? "";
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

/** Return true when an unknown error shape represents a timeout. */
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
  const cause = "cause" in err ? err.cause : undefined;
  const reason = "reason" in err ? err.reason : undefined;
  return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}

/** Return true when an abort-signal reason is an intentional timeout; plain AbortError is a cancellation, not a timeout. */
export function isSignalTimeoutReason(reason: unknown): boolean {
  try {
    return readErrorName(reason) === "TimeoutError";
  } catch {
    return false;
  }
}
