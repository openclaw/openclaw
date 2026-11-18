// Retain raw appenders for transcript repair without changing SessionManager's public shape.
import type { SessionManager } from "./sessions/index.js";

const rawAppenders = new WeakMap<SessionManager, SessionManager["appendMessage"]>();
const rawAsyncAppenders = new WeakMap<SessionManager, SessionManager["appendMessageAsync"]>();

/** Return the unguarded appendMessage implementation for a session manager. */
export function getRawSessionAppendMessage(
  sessionManager: SessionManager,
): SessionManager["appendMessage"] {
  return rawAppenders.get(sessionManager) ?? sessionManager.appendMessage.bind(sessionManager);
}

/** Retains the unguarded appendMessage implementation for a session manager. */
export function setRawSessionAppendMessage(
  sessionManager: SessionManager,
  appendMessage: SessionManager["appendMessage"],
): void {
  rawAppenders.set(sessionManager, appendMessage);
}

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
