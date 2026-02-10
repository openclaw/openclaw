import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { ProvenanceTracker } from "./provenance.js";
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
  opts?: {
    agentId?: string;
    sessionKey?: string;
    allowSyntheticToolResults?: boolean;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const extractToolResultText = (message: AgentMessage): string => {
    if ((message as { role?: unknown }).role !== "toolResult") {
      return "";
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
  };

  const hookRunner = getGlobalHookRunner();
  const transform = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ): AgentMessage => {
    if (opts?.sessionKey && meta.toolName && !meta.isSynthetic) {
      const text = extractToolResultText(message);
      if (text) {
        ProvenanceTracker.getInstance(opts.sessionKey).recordTaint(meta.toolName, text);
      }
    }

    if (!hookRunner?.hasHooks("tool_result_persist")) {
      return message;
    }
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
  };

  const guard = installSessionToolResultGuard(sessionManager, {
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
