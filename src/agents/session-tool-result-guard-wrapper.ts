import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
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
    providerMetadata?: Record<string, unknown>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  if (opts?.providerMetadata && Object.keys(opts.providerMetadata).length > 0) {
    const originalAppend = sessionManager.appendMessage.bind(sessionManager);
    const providerMetadata = opts.providerMetadata;
    sessionManager.appendMessage = ((message: AgentMessage) => {
      if (!message || typeof message !== "object") {
        return originalAppend(message as never);
      }
      const existing = (message as { providerMetadata?: unknown }).providerMetadata;
      const existingObj =
        existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
      const merged = {
        ...(message as Record<string, unknown>),
        providerMetadata: {
          ...(existingObj as Record<string, unknown>),
          ...providerMetadata,
        },
      };
      return originalAppend(merged as AgentMessage);
    }) as SessionManager["appendMessage"];
  }

  const hookRunner = getGlobalHookRunner();
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
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
