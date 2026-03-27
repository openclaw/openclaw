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
    providerMetadata?: Record<string, unknown>;
    allowedToolNames?: Iterable<string>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  if (opts?.providerMetadata && Object.keys(opts.providerMetadata).length > 0) {
    const originalAppend = sessionManager.appendMessage.bind(sessionManager);
    type SessionMessage = Parameters<typeof originalAppend>[0];
    const providerMetadata = opts.providerMetadata;
    sessionManager.appendMessage = ((message: SessionMessage) => {
      if (!message || typeof message !== "object" || Array.isArray(message as unknown)) {
        return originalAppend(message);
      }
      const messageRecord = message as unknown as Record<string, unknown>;
      const existing = messageRecord.providerMetadata;
      const existingObj =
        existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
      const merged = {
        ...messageRecord,
        providerMetadata: {
          ...(existingObj as Record<string, unknown>),
          ...providerMetadata,
        },
      };
      return originalAppend(merged as unknown as SessionMessage);
    }) as SessionManager["appendMessage"];
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
    sessionKey: opts?.sessionKey,
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
