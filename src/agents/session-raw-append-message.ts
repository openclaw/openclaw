// Retain raw appenders for transcript repair without changing SessionManager's public shape.
import type { SessionManager } from "./sessions/index.js";

const rawAsyncAppenders = new WeakMap<SessionManager, SessionManager["appendMessageAsync"]>();

export function getRawSessionAppendMessageAsync(
  sessionManager: SessionManager,
): SessionManager["appendMessageAsync"] {
  return (
    rawAsyncAppenders.get(sessionManager) ?? sessionManager.appendMessageAsync.bind(sessionManager)
  );
}

export function setRawSessionAppendMessageAsync(
  sessionManager: SessionManager,
  appendMessage: SessionManager["appendMessageAsync"],
): void {
  rawAsyncAppenders.set(sessionManager, appendMessage);
}
