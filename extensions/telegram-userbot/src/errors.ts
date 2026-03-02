/**
 * Typed error wrappers for GramJS exceptions.
 *
 * Converts raw GramJS RPCError subclasses into OpenClaw-typed errors
 * with structured codes and optional retryAfter hints.
 */

export type UserbotErrorCode =
  | "FLOOD_WAIT"
  | "AUTH_ERROR"
  | "RPC_ERROR"
  | "PEER_NOT_FOUND"
  | "DISCONNECTED"
  | "UNKNOWN_ERROR";

/**
 * Base error for all userbot client operations.
 * Every GramJS exception is wrapped into one of these.
 */
export class UserbotError extends Error {
  readonly code: UserbotErrorCode;
  /** Seconds to wait before retry (flood control). Undefined if not applicable. */
  readonly retryAfter: number | undefined;

  constructor(message: string, code: UserbotErrorCode, retryAfter?: number) {
    super(message);
    this.name = "UserbotError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Flood-wait error -- Telegram is rate-limiting this request. */
export class UserbotFloodError extends UserbotError {
  constructor(seconds: number, cause?: unknown) {
    super(`Flood wait: retry after ${seconds}s`, "FLOOD_WAIT", seconds);
    this.name = "UserbotFloodError";
    this.cause = cause;
  }
}

/** Auth error -- session is invalid, revoked, or auth failed. */
export class UserbotAuthError extends UserbotError {
  constructor(message: string, cause?: unknown) {
    super(`Auth error: ${message}`, "AUTH_ERROR");
    this.name = "UserbotAuthError";
    this.cause = cause;
  }
}

/** Peer could not be resolved (bad chat ID, unknown username, etc.). */
export class UserbotPeerError extends UserbotError {
  constructor(input: string | number | bigint, cause?: unknown) {
    super(`Failed to resolve peer: ${String(input)}`, "PEER_NOT_FOUND");
    this.name = "UserbotPeerError";
    this.cause = cause;
  }
}

/** Client is disconnected from Telegram. */
export class UserbotDisconnectedError extends UserbotError {
  constructor(message?: string, cause?: unknown) {
    super(message ?? "Client is disconnected", "DISCONNECTED");
    this.name = "UserbotDisconnectedError";
    this.cause = cause;
  }
}

/**
 * Wraps a GramJS exception into a typed UserbotError.
 *
 * Inspects the error to pick the most specific wrapper:
 *  - FloodWaitError (has .seconds) -> UserbotFloodError
 *  - RPCError with AUTH-related message -> UserbotAuthError
 *  - Other RPCError -> UserbotError with UNKNOWN_ERROR
 *  - Already a UserbotError -> returned as-is
 *  - Everything else -> UserbotError with UNKNOWN_ERROR
 */
export function wrapGramJSError(err: unknown): UserbotError {
  if (err instanceof UserbotError) {
    return err;
  }

  // Duck-type check for GramJS errors without importing the classes directly.
  // This avoids hard runtime dependency on telegram package at import time
  // and makes the function testable with plain objects.
  if (err instanceof Error) {
    const name = err.constructor.name;

    // FloodWaitError has a .seconds property
    if (name === "FloodWaitError" && "seconds" in err) {
      const seconds = (err as Error & { seconds: number }).seconds;
      return new UserbotFloodError(seconds, err);
    }

    // Generic FloodError (parent of FloodWaitError)
    if (name === "FloodError" || name === "FloodWaitError") {
      const seconds = "seconds" in err ? (err as Error & { seconds: number }).seconds : 0;
      return new UserbotFloodError(seconds, err);
    }

    // AuthKeyError or RPCError with AUTH in message
    if (name === "AuthKeyError") {
      return new UserbotAuthError(err.message, err);
    }

    if (name === "RPCError" || name.endsWith("Error")) {
      const msg = err.message || "";
      // Check for auth-related RPC errors
      if (
        msg.includes("AUTH") ||
        msg.includes("SESSION") ||
        msg.includes("PHONE_CODE_INVALID") ||
        msg.includes("PASSWORD")
      ) {
        return new UserbotAuthError(msg, err);
      }
    }

    return new UserbotError(err.message, "UNKNOWN_ERROR");
  }

  return new UserbotError(String(err), "UNKNOWN_ERROR");
}
