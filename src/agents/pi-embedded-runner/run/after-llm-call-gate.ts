/**
 * Mutable ref bridge between after_llm_call and before_tool_call.
 *
 * after_llm_call runs inside a streaming subscription callback, so it can't
 * directly intercept tool execution in the agent loop. Instead, it stores
 * block/filter decisions here, and before_tool_call checks them before each
 * tool executes.
 *
 * Keyed by sessionId so concurrent sessions don't interfere.
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/after-llm-call-gate");

export interface AfterLlmCallGate {
  /** Block ALL tool calls this turn. */
  blocked: boolean;
  blockReason?: string;
  /** If set, only these tool call IDs are allowed. Others are blocked. */
  allowedToolCallIds?: Set<string>;
  /** Iteration when this gate was set (for staleness detection). */
  iteration: number;
}

const gates = new Map<string, AfterLlmCallGate>();

/**
 * Set the gate for a session. Called from the after_llm_call subscription
 * callback when the hook returns block or filtered toolCalls.
 */
export function setAfterLlmCallGate(sessionId: string, gate: AfterLlmCallGate): void {
  gates.set(sessionId, gate);
  if (gate.blocked) {
    log.debug(`gate set: session=${sessionId} blocked=true reason=${gate.blockReason ?? "none"}`);
  } else if (gate.allowedToolCallIds) {
    log.debug(
      `gate set: session=${sessionId} allowedTools=${gate.allowedToolCallIds.size} iteration=${gate.iteration}`,
    );
  }
}

/**
 * Check the gate for a tool call. Returns { blocked, reason } if the tool
 * should not execute.
 */
export function checkAfterLlmCallGate(
  sessionId: string,
  toolCallId?: string,
): { blocked: boolean; reason?: string } {
  const gate = gates.get(sessionId);
  if (!gate) {
    return { blocked: false };
  }

  if (gate.blocked) {
    return { blocked: true, reason: gate.blockReason ?? "Blocked by after_llm_call hook" };
  }

  if (gate.allowedToolCallIds) {
    if (!toolCallId || !gate.allowedToolCallIds.has(toolCallId)) {
      return {
        blocked: true,
        reason: toolCallId
          ? `Tool call ${toolCallId} filtered by after_llm_call hook`
          : "Tool call has no ID and cannot be verified against after_llm_call allowlist",
      };
    }
  }

  return { blocked: false };
}

/**
 * Clear the gate for a session. Called at turn boundaries to prevent
 * stale decisions from affecting the next turn.
 */
export function clearAfterLlmCallGate(sessionId: string): void {
  gates.delete(sessionId);
}
