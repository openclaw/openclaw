/**
 * Backward-compat shim for the pending-agent-injection consumer.
 *
 * The underlying storage is now a typed queue (`SessionEntry.
 * pendingAgentInjections`) managed by `src/agents/plan-mode/
 * injections.ts`. This file preserves the original `{ text: string |
 * undefined }` API used by callers outside the plan-mode surface (e.g.
 * `src/auto-reply/reply/agent-runner-execution.ts:1082`) so the queue
 * rewrite ships without a disruptive refactor of every consumer.
 *
 * New code should prefer the typed helpers in
 * `src/agents/plan-mode/injections.ts`:
 *   - `enqueuePendingAgentInjection(sessionKey, entry)`
 *   - `consumePendingAgentInjections(sessionKey)` — returns the full
 *     entry array so callers can reason about `kind` / `approvalId`
 *   - `composePromptWithPendingInjections(entries, userPrompt)`
 */

import {
  composePromptWithPendingInjections,
  consumePendingAgentInjections,
} from "../plan-mode/injections.js";

export interface ConsumePendingAgentInjectionResult {
  /** The composed injection text, or `undefined` if the queue was empty. */
  text: string | undefined;
}

/**
 * Atomically drains the session's pending-injection queue and returns
 * the composed text (entries joined with `\n\n` in priority order).
 *
 * Preserves the pre-queue scalar API: returns `{ text: undefined }`
 * when nothing is pending, `{ text: "..." }` otherwise.
 *
 * Best-effort error semantics (Copilot review #68939 wave-2 wave-1
 * compatible): on store-write failure inside the underlying queue
 * helper, the queue helper drops the captured entries and returns an
 * empty array — favoring the once-and-only-once guarantee over
 * caller-can-still-inject. Operators see the warn-log line for any
 * disk failure path.
 */
export async function consumePendingAgentInjection(
  sessionKey: string,
  log?: { warn?: (msg: string) => void },
): Promise<ConsumePendingAgentInjectionResult> {
  const result = await consumePendingAgentInjections(sessionKey, log);
  return { text: result.composedText };
}

/**
 * Composes a single injection string onto the user's prompt. Preserved
 * as a thin wrapper over `composePromptWithPendingInjections` so
 * existing callers that hold a scalar injection still work unchanged.
 *
 * Returns the user prompt unchanged when `injectionText` is
 * `undefined` or empty. When the user prompt is empty/whitespace-only,
 * the injection stands alone with no trailing blanks.
 */
export function composePromptWithPendingInjection(
  injectionText: string | undefined,
  userPrompt: string,
): string {
  if (!injectionText || injectionText.length === 0) {
    return userPrompt;
  }
  // Bridge scalar → queue-shaped input so ordering/composition logic
  // lives in one place.
  return composePromptWithPendingInjections(
    [{ id: "legacy", kind: "plan_decision", text: injectionText, createdAt: 0 }],
    userPrompt,
  );
}
