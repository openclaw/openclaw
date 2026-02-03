import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { redactSensitiveText } from "../logging/redact.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

/**
 * Recursively redact sensitive content from any value (string, object, array).
 * Returns the redacted value and whether any changes were made.
 */
function redactValue(value: unknown): { result: unknown; modified: boolean } {
  if (typeof value === "string") {
    const redacted = redactSensitiveText(value, { mode: "tools" });
    return { result: redacted, modified: redacted !== value };
  }

  if (Array.isArray(value)) {
    let modified = false;
    const result = value.map((item) => {
      const r = redactValue(item);
      if (r.modified) modified = true;
      return r.result;
    });
    return { result, modified };
  }

  if (value && typeof value === "object") {
    let modified = false;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactValue(v);
      if (r.modified) modified = true;
      result[k] = r.result;
    }
    return { result, modified };
  }

  return { result: value, modified: false };
}

/**
 * Redact sensitive content (API keys, tokens, secrets) from tool result messages
 * before they are persisted to session transcripts.
 *
 * Redacts content, details, and any other fields that may contain secrets.
 */
function redactToolResultContent(message: AgentMessage): AgentMessage {
  const role = (message as { role?: unknown }).role;
  if (role !== "toolResult") {
    return message;
  }

  const msg = message as unknown as Record<string, unknown>;
  let modified = false;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(msg)) {
    if (key === "role" || key === "toolCallId" || key === "isError") {
      result[key] = value;
      continue;
    }
    const r = redactValue(value);
    if (r.modified) modified = true;
    result[key] = r.result;
  }

  if (!modified) {
    return message;
  }

  return result as unknown as AgentMessage;
}

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

  const hookRunner = getGlobalHookRunner();

  // Always redact secrets from tool results before persistence.
  // Redaction runs both before and after plugin hooks to ensure secrets
  // cannot leak even if a hook reintroduces sensitive content.
  const transform = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ): AgentMessage => {
    // First pass: redact sensitive content (API keys, tokens, secrets)
    let result = redactToolResultContent(message);

    // Apply plugin hooks if registered
    if (hookRunner?.hasHooks("tool_result_persist")) {
      const out = hookRunner.runToolResultPersist(
        {
          toolName: meta.toolName,
          toolCallId: meta.toolCallId,
          message: result,
          isSynthetic: meta.isSynthetic,
        },
        {
          agentId: opts?.agentId,
          sessionKey: opts?.sessionKey,
          toolName: meta.toolName,
          toolCallId: meta.toolCallId,
        },
      );
      result = out?.message ?? result;

      // Second pass: ensure hooks didn't reintroduce secrets
      result = redactToolResultContent(result);
    }

    return result;
  };

  const guard = installSessionToolResultGuard(sessionManager, {
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
