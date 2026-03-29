import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

function buildGuardAnnotationWarningText(annotations?: Array<{ message: string }>): string[] {
  return (annotations ?? []).map((annotation) => annotation.message.trim()).filter(Boolean);
}

function prependToolResultWarning(message: AgentMessage, warningText: string): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const toolResult = message as Extract<AgentMessage, { role: "toolResult" }>;
  const firstBlock = toolResult.content?.[0];
  if (firstBlock?.type === "text") {
    return {
      ...toolResult,
      content: [
        { ...firstBlock, text: `${warningText}\n\n${firstBlock.text}` },
        ...toolResult.content.slice(1),
      ],
    };
  }
  return {
    ...toolResult,
    content: [{ type: "text", text: warningText }, ...(toolResult.content ?? [])],
  };
}

function buildBlockedToolResultMessage(message: AgentMessage, reason: string): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const toolResult = message as Extract<AgentMessage, { role: "toolResult" }>;
  return {
    ...toolResult,
    isError: true,
    content: [{ type: "text", text: reason }],
  };
}

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

  const transform =
    hookRunner?.hasHooks("before_tool_result_deliver") ||
    hookRunner?.hasHooks("tool_result_persist")
      ? (
          message: AgentMessage,
          meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
        ) => {
          let current = message;
          if (hookRunner?.hasHooks("before_tool_result_deliver")) {
            const guardResult = hookRunner.runBeforeToolResultDeliver(
              {
                toolName: meta.toolName,
                toolCallId: meta.toolCallId,
                message: current,
                isSynthetic: meta.isSynthetic,
              },
              {
                agentId: opts?.agentId,
                sessionKey: opts?.sessionKey,
                toolName: meta.toolName,
                toolCallId: meta.toolCallId,
              },
            );
            if (guardResult?.message) {
              current = guardResult.message;
            }
            if (guardResult?.decision === "warn") {
              const warningParts = [
                guardResult.reason?.trim(),
                ...buildGuardAnnotationWarningText(guardResult.annotations),
              ].filter(Boolean);
              if (warningParts.length > 0) {
                current = prependToolResultWarning(
                  current,
                  `[Guard warning] ${warningParts.join(" | ")}`,
                );
              }
            } else if (guardResult?.decision === "deny" || guardResult?.decision === "escalate") {
              current = buildBlockedToolResultMessage(
                current,
                guardResult.reason?.trim() || "Tool result blocked by security guard.",
              );
            }
          }
          if (!hookRunner?.hasHooks("tool_result_persist")) {
            return current;
          }
          const out = hookRunner.runToolResultPersist(
            {
              toolName: meta.toolName,
              toolCallId: meta.toolCallId,
              message: current,
              isSynthetic: meta.isSynthetic,
            },
            {
              agentId: opts?.agentId,
              sessionKey: opts?.sessionKey,
              toolName: meta.toolName,
              toolCallId: meta.toolCallId,
            },
          );
          return out?.message ?? current;
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
