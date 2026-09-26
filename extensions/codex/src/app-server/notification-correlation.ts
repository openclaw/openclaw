import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

export function isCodexNotificationForTurn(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    readCodexNotificationThreadId(value) === threadId &&
    readCodexNotificationTurnId(value) === turnId
  );
}

/**
 * Reads a thread id from canonical top-level or nested thread payloads.
 * The generated v2 schemas require top-level `threadId` on turn/item-scoped
 * notifications and define `Turn` without one, so `turn.threadId` is not a
 * wire shape and is deliberately not read here.
 */
export function readCodexNotificationThreadId(record: JsonObject): string | undefined {
  const thread = isJsonObject(record.thread) ? record.thread : undefined;
  return (
    normalizeOptionalString(record.threadId) ??
    (thread ? normalizeOptionalString(thread.id) : undefined)
  );
}

export function readCodexNotificationTurnId(record: JsonObject): string | undefined {
  return (
    (isJsonObject(record.turn) ? normalizeOptionalString(record.turn.id) : undefined) ??
    normalizeOptionalString(record.turnId)
  );
}
