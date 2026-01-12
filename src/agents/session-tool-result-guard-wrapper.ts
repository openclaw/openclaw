import type { SessionManager } from "@mariozechner/pi-coding-agent";

import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const guard = installSessionToolResultGuard(sessionManager);
  (sessionManager as GuardedSessionManager).flushPendingToolResults =
    guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}

