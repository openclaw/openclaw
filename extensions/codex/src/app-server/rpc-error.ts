import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isJsonObject, type JsonValue } from "./protocol.js";

export const CODEX_APP_SERVER_OVERLOADED_ERROR_CODE = -32_001;

/** A scoped guard rejected the request before a physical write. */
export class CodexAppServerScopedRequestRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerScopedRequestRejectedError";
  }
}

/** Only definite pre-write rejection permits recovering the original startup cause. */
export function codexPrewriteRejectionCause(error: unknown): unknown {
  return error instanceof CodexAppServerScopedRequestRejectedError && error.cause !== undefined
    ? error.cause
    : error;
}

/** RPC error wrapper that preserves app-server error code and data. */
export class CodexAppServerRpcError extends Error {
  readonly code?: number;
  readonly data?: JsonValue;
  readonly method: string;

  constructor(error: { code?: number; message: string; data?: JsonValue }, method: string) {
    const message = error.message || `${method} failed`;
    const detail = readCodexAppServerRpcReloginDetail(error.data);
    super(detail && !message.includes(detail) ? `${message}: ${detail}` : message);
    this.name = "CodexAppServerRpcError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

export function isCodexThreadReadMissingError(error: unknown, threadId: string): boolean {
  // codex-rs read_thread_view uses this exact invalid_request for a gone thread.
  // Other validation/storage errors cannot authorize unlinking or replacement.
  return (
    error instanceof CodexAppServerRpcError &&
    error.method === "thread/read" &&
    error.code === -32_600 &&
    error.message === `thread not loaded: ${threadId}`
  );
}

function readCodexAppServerRpcReloginDetail(data: JsonValue | undefined): string | undefined {
  const record = isJsonObject(data) ? data : undefined;
  const nested = isJsonObject(record?.error) ? record.error : record;
  if (!nested) {
    return undefined;
  }
  const isRelogin =
    nested.action === "relogin" ||
    (nested.reason === "cloudRequirements" && nested.errorCode === "Auth");
  const detail = typeof nested.detail === "string" ? nested.detail.trim() : "";
  return isRelogin && detail ? detail : undefined;
}

export class CodexAppServerLocalRequestCancellationError extends Error {
  readonly code = "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED";

  constructor(
    method: string,
    readonly reason: "aborted" | "timed out",
    readonly mayHaveWritten: boolean,
    cause?: unknown,
  ) {
    const detail =
      cause instanceof Error || typeof cause === "string" ? coerceErrorMessage(cause) : undefined;
    super(`${method} ${reason}${detail ? `: ${detail}` : ""}`, { cause });
    this.name = "CodexAppServerLocalRequestCancellationError";
  }
}

/** Codex rejects this exact code before enqueueing, including mutating requests. */
export function isCodexAppServerOverloadError(error: unknown): error is CodexAppServerRpcError {
  return (
    error instanceof CodexAppServerRpcError && error.code === CODEX_APP_SERVER_OVERLOADED_ERROR_CODE
  );
}

export function isCodexAppServerRequestTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
    "reason" in error &&
    error.reason === "timed out"
  );
}

export class CodexAppServerIndeterminateTransportError extends Error {
  readonly code = "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE";
  readonly mayHaveWritten = true;

  constructor(method: string, cause: Error) {
    super(`${method} transport failed after request write: ${cause.message}`, { cause });
    this.name = "CodexAppServerIndeterminateTransportError";
  }
}

/** True when a local cancellation can leave an app-server request in flight. */
export function isCodexAppServerIndeterminateRequestCancellationError(
  error: unknown,
): error is Error & { code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED"; mayHaveWritten: true } {
  return hasRequestWriteState(error, "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED", true);
}

/** True when local cancellation happened before a request write was attempted. */
export function isCodexAppServerPrewriteRequestCancellationError(
  error: unknown,
): error is Error & { code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED"; mayHaveWritten: false } {
  return hasRequestWriteState(error, "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED", false);
}

/** True when transport failure cannot prove a written request stopped running. */
export function isCodexAppServerIndeterminateTransportError(error: unknown): error is Error & {
  code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE";
  mayHaveWritten: true;
} {
  return hasRequestWriteState(error, "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE", true);
}

function hasRequestWriteState(error: unknown, code: string, written: boolean): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code &&
    "mayHaveWritten" in error &&
    error.mayHaveWritten === written
  );
}

export function isCodexAppServerConnectionClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (isCodexAppServerIndeterminateTransportError(error)) {
    return true;
  }
  return (
    error.message === "codex app-server client is closed" ||
    error.message.startsWith("codex app-server exited:")
  );
}
