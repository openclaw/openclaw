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
    super(formatCodexAppServerRpcErrorMessage(error, method));
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

function formatCodexAppServerRpcErrorMessage(
  error: { message: string; data?: JsonValue },
  method: string,
): string {
  const message = error.message || `${method} failed`;
  const detail = readCodexAppServerRpcReloginDetail(error.data);
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
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
