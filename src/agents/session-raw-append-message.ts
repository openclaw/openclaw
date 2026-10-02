/**
 * Stores and retrieves an unguarded SessionManager appendMessage function.
 * Transcript repair paths use this symbol slot to bypass wrappers without
 * changing the public SessionManager interface.
 */
import type { SessionManager } from "./sessions/index.js";

const RAW_APPEND_MESSAGE = Symbol("openclaw.session.rawAppendMessage");
const RAW_APPEND_MESSAGE_ASYNC = Symbol("openclaw.session.rawAppendMessageAsync");

type SessionManagerWithRawAppend = SessionManager & {
  [RAW_APPEND_MESSAGE]?: SessionManager["appendMessage"];
  [RAW_APPEND_MESSAGE_ASYNC]?: SessionManager["appendMessageAsync"];
};

/** Return the unguarded appendMessage implementation for a session manager. */
export function getRawSessionAppendMessage(
  sessionManager: SessionManager,
): SessionManager["appendMessage"] {
  const rawManager: SessionManagerWithRawAppend = sessionManager;
  const rawAppend = rawManager[RAW_APPEND_MESSAGE];
  return rawAppend ?? sessionManager.appendMessage.bind(sessionManager);
}

/** Stores the unguarded appendMessage implementation on a session manager. */
export function setRawSessionAppendMessage(
  sessionManager: SessionManager,
  appendMessage: SessionManager["appendMessage"],
): void {
  const rawManager: SessionManagerWithRawAppend = sessionManager;
  rawManager[RAW_APPEND_MESSAGE] = appendMessage;
}

export function getRawSessionAppendMessageAsync(
  sessionManager: SessionManager,
): SessionManager["appendMessageAsync"] {
  const rawManager: SessionManagerWithRawAppend = sessionManager;
  return (
    rawManager[RAW_APPEND_MESSAGE_ASYNC] ?? sessionManager.appendMessageAsync.bind(sessionManager)
  );
}

export function setRawSessionAppendMessageAsync(
  sessionManager: SessionManager,
  appendMessage: SessionManager["appendMessageAsync"],
): void {
  const rawManager: SessionManagerWithRawAppend = sessionManager;
  rawManager[RAW_APPEND_MESSAGE_ASYNC] = appendMessage;
}
