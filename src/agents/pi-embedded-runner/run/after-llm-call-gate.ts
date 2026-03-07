/**
 * Promise-based gate bridge between after_llm_call and before_tool_call.
 *
 * after_llm_call fires from the streamFn wrapper inside agentLoop's
 * async context. The hook result is stored as a Promise that the tool
 * wrapper awaits before each tool.execute() call. This makes enforcement
 * deterministic — the first tool call blocks until the hook resolves,
 * and subsequent calls in the same turn get the cached result instantly.
 *
 * ## Why a Promise (not a sync value)?
 *
 * The hook fires synchronously when the LLM response stream completes,
 * but the hook handlers may be async (e.g. network policy lookups).
 * Storing the Promise immediately (before streamAssistantResponse returns)
 * guarantees it's available when executeToolCalls starts, because both
 * run in the same agentLoop async context:
 *
 *   streamAssistantResponse() → wrapper fires hook, stores Promise → returns
 *   executeToolCalls() → tool.execute() → tool wrapper awaits Promise
 *
 * ## Previous design (replaced)
 *
 * The previous implementation used a synchronous mutable ref populated
 * via .then() from a subscription callback (Agent's async context).
 * This was "best-effort" — tools could execute before the gate was set.
 * It required monotonic sequence counters and staleness detection to
 * handle race conditions between turns.
 *
 * Keyed by sessionId so concurrent sessions don't interfere.
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/after-llm-call-gate");

export interface GateDecision {
  /** Block ALL tool calls this turn. */
  blocked: boolean;
  blockReason?: string;
  /** If set, only these tool call IDs are allowed. Others are blocked. */
  allowedToolCallIds?: Set<string>;
}

const gates = new Map<string, Promise<GateDecision>>();

/**
 * Store the gate Promise for a session. Called synchronously from the
 * streamFn wrapper when the LLM response completes.
 *
 * The promise resolves to a GateDecision when runAfterLlmCall completes.
 * Errors are caught internally — a failed hook resolves to { blocked: false }
 * (fail open) rather than rejecting.
 */
export function setAfterLlmCallGatePromise(
  sessionId: string,
  hookPromise: Promise<
    { block?: boolean; blockReason?: string; toolCalls?: Array<{ id: string }> } | undefined
  >,
): void {
  const gatePromise = hookPromise
    .then((result) => {
      if (!result || (!result.block && !result.toolCalls)) {
        return { blocked: false } as GateDecision;
      }
      const decision: GateDecision = {
        blocked: result.block ?? false,
        blockReason: result.blockReason,
        allowedToolCallIds: result.toolCalls
          ? new Set(result.toolCalls.map((tc) => tc.id))
          : undefined,
      };
      if (decision.blocked) {
        log.debug(
          `gate set: session=${sessionId} blocked=true reason=${decision.blockReason ?? "none"}`,
        );
      } else if (decision.allowedToolCallIds) {
        log.debug(
          `gate set: session=${sessionId} allowedTools=${decision.allowedToolCallIds.size}`,
        );
      }
      return decision;
    })
    .catch((err) => {
      log.warn(`after_llm_call hook error (failing open): ${String(err)}`);
      return { blocked: false } as GateDecision;
    });

  gates.set(sessionId, gatePromise);
}

/**
 * Check the gate for a tool call. Awaits the stored Promise so the first
 * tool call blocks until the hook resolves. Subsequent calls in the same
 * turn get the cached (already-resolved) Promise instantly.
 *
 * Returns { blocked: false } if no gate is set (no hooks registered or
 * the message had no tool calls).
 */
export async function checkAfterLlmCallGate(
  sessionId: string,
  toolCallId?: string,
): Promise<{ blocked: boolean; reason?: string }> {
  const promise = gates.get(sessionId);
  if (!promise) {
    return { blocked: false };
  }

  const gate = await promise;

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
