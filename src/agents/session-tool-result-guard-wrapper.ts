import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
  clearPendingToolResults?: () => void;
};

/**
 * Module-level registry of pending-flush callbacks for all active guarded sessions.
 *
 * Each entry is the session-level flushPendingToolResults wrapper. The wrapper
 * removes itself from this set when called directly (normal teardown path), so
 * the set only ever holds sessions whose tool calls are still unresolved.
 *
 * flushAllActiveSessionGuards() drains this set during gateway restart.
 */
const activeSessionGuardFlushes = new Set<() => void>();

/**
 * Flush pending tool results for ALL currently active guarded sessions.
 *
 * Called by the gateway restart sequence (run-loop) after the drain phase,
 * before server.close().  Prevents orphaned tool_use blocks in JSONL
 * transcripts that would otherwise cause silent turns on the next startup.
 *
 * Safe to call at any time; idempotent per session.
 */
export function flushAllActiveSessionGuards(): void {
  const flushes = Array.from(activeSessionGuardFlushes);
  activeSessionGuardFlushes.clear();
  for (const flush of flushes) {
    try {
      flush();
    } catch {
      // Best-effort: flush as many sessions as possible even if one throws.
    }
  }
}

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    allowedToolNames?: Iterable<string>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  const beforeMessageWrite = hookRunner?.hasHooks("before_message_write")
    ? (event: { message: import("@mariozechner/pi-agent-core").AgentMessage }) => {
        return hookRunner.runBeforeMessageWrite(event, {
          agentId: opts?.agentId,
          sessionKey: opts?.sessionKey,
        });
      }
    : undefined;

  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? // oxlint-disable-next-line typescript/no-explicit-any
      (message: any, meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean }) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  const guard = installSessionToolResultGuard(sessionManager, {
    transformMessageForPersistence: (message) =>
      applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    allowedToolNames: opts?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
  });

  // Wrap flushPendingToolResults to auto-deregister from the global restart
  // registry when the session flushes via the normal teardown path.  This
  // prevents the global flush from double-invoking an already-flushed session.
  const rawFlush = guard.flushPendingToolResults;
  const wrappedFlush = () => {
    activeSessionGuardFlushes.delete(wrappedFlush);
    rawFlush();
  };
  activeSessionGuardFlushes.add(wrappedFlush);

  (sessionManager as GuardedSessionManager).flushPendingToolResults = wrappedFlush;

  // Wrap clearPendingToolResults symmetrically so sessions that discard (instead
  // of flush) also deregister from the global restart registry — prevents the
  // set from accumulating closures indefinitely in long-running gateways.
  const rawClear = guard.clearPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = rawClear
    ? () => {
        activeSessionGuardFlushes.delete(wrappedFlush);
        rawClear();
      }
    : () => {
        activeSessionGuardFlushes.delete(wrappedFlush);
      };
  return sessionManager as GuardedSessionManager;
}
