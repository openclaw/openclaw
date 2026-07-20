// Shared redaction helpers for the mail-wake plugin. Logs and errors must
// never carry secrets, tokens, mailbox addresses, subscription ids, or Graph
// paths: handles are salted hashes, and error descriptions are names only —
// error messages can embed request URLs and response material.
import { createHash } from "node:crypto";
import { GraphRequestError } from "./graph-client.js";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Non-reversible log handle for an identifier (subscription id, mailbox user). */
export function redactHandle(value: string): string {
  return sha256Hex(`msgraph-mail-wake-handle|${value}`).slice(0, 16);
}

/**
 * Name-only error description for logs. Error messages from fetch, auth, and
 * Graph clients can embed URLs, tokens, and mailbox data, so only the error
 * class/name is safe to log.
 */
export function describeErrorRedacted(error: unknown): string {
  if (error instanceof TypeError) {
    return "TypeError";
  }
  if (error instanceof RangeError) {
    return "RangeError";
  }
  if (error instanceof ReferenceError) {
    return "ReferenceError";
  }
  if (error instanceof SyntaxError) {
    return "SyntaxError";
  }
  if (error instanceof URIError) {
    return "URIError";
  }
  if (error instanceof EvalError) {
    return "EvalError";
  }
  // GraphRequestError builds an already-sanitized message (op + status + code
  // only — no body, path, or raw Graph message), so it is safe to surface in
  // full. Using instanceof (not a duck-typed name check) is spoof-proof: only a
  // real GraphRequestError, whose constructor builds the sanitized message, is
  // passed through. (There is no import cycle: graph-client does not import
  // redact.)
  if (error instanceof GraphRequestError) {
    return error.message;
  }
  if (error instanceof Error) {
    return "Error";
  }
  return typeof error;
}
