import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import { toCanonicalInboundMessageHookContext } from "../hooks/message-hook-mappers.js";
import { queueSessionSanitizationWrite } from "../memory/session-sanitization/service.js";
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
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    cfg?: OpenClawConfig;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    allowedToolNames?: Iterable<string>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  // Helper/memory sessions have sessionId starting with "session-memory-" and
  // sessionKey containing ":session-memory-". Sanitizing their transcript would
  // re-enqueue the helper prompt itself, spawning recursive background work.
  const isHelperSession =
    (opts?.sessionId?.startsWith("session-memory-") ?? false) ||
    (opts?.sessionKey?.includes(":session-memory-") ?? false);
  const hasSanitization = !!(opts?.cfg && opts?.agentId && opts?.sessionId && !isHelperSession);
  const hasHooks = hookRunner?.hasHooks("before_message_write") ?? false;
  const beforeMessageWrite =
    hasSanitization || hasHooks
      ? (event: { message: import("@mariozechner/pi-agent-core").AgentMessage }) => {
          const result =
            hasHooks && hookRunner
              ? hookRunner.runBeforeMessageWrite(event, {
                  agentId: opts?.agentId,
                  sessionKey: opts?.sessionKey,
                })
              : undefined;
          if (hasSanitization) {
            const canonical = toCanonicalInboundMessageHookContext(event.message);
            if (canonical) {
              queueSessionSanitizationWrite({
                cfg: opts!.cfg!,
                agentId: opts!.agentId!,
                sessionId: opts!.sessionId,
                canonical,
              });
            }
          }
          return result;
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
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = guard.clearPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
