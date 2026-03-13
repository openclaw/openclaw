import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { redactSensitiveText } from "../logging/redact.js";
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

// oxlint-disable-next-line typescript/no-explicit-any
function redactMessageContent(message: any): any {
  if (!message || typeof message !== "object") {
    return message;
  }
  const copy = { ...message };
  if (typeof copy.content === "string") {
    copy.content = redactSensitiveText(copy.content);
  } else if (Array.isArray(copy.content)) {
    // oxlint-disable-next-line typescript/no-explicit-any
    copy.content = copy.content.map((block: any) => {
      if (block.type === "text" && typeof block.text === "string") {
        return { ...block, text: redactSensitiveText(block.text) };
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        return { ...block, thinking: redactSensitiveText(block.thinking) };
      }
      return block;
    });
  }
  return copy;
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
    transformMessageForPersistence: (message) => {
      const withProvenance = applyInputProvenanceToUserMessage(message, opts?.inputProvenance);
      return redactMessageContent(withProvenance);
    },
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    allowedToolNames: opts?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = guard.clearPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
