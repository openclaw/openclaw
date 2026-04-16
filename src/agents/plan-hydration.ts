/**
 * Post-compaction plan hydration — ported from Hermes Agent's
 * TodoStore.format_for_injection() (tools/todo_tool.py).
 *
 * After context compression, active plan items (pending / in_progress)
 * are injected as a user message so the agent continues the same plan
 * instead of re-planning from scratch.
 *
 * The injected text is deliberately phrased as a factual statement
 * ("Your active plan was preserved...") rather than an imperative
 * ("Here is your plan, do this...") to avoid triggering the
 * planning-only retry guard's promise-language detection in
 * incomplete-turn.ts (PLANNING_ONLY_PROMISE_RE).
 */

interface PlanStep {
  step: string;
  status: string;
  activeForm?: string;
}

const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

/**
 * Formats active plan steps for injection after compaction.
 * Returns `null` if there are no active steps to preserve.
 *
 * Matches Hermes's format_for_injection() output:
 *   [Your active task list was preserved across context compression]
 *   - [ ] step text (pending)
 *   - [>] step text (in_progress)
 */
export function formatPlanForHydration(steps: PlanStep[]): string | null {
  const active = steps.filter((s) => ACTIVE_STATUSES.has(s.status));
  if (active.length === 0) {
    return null;
  }

  const lines = ["[Your active plan was preserved across context compression]"];
  for (const s of active) {
    const marker = s.status === "in_progress" ? "[>]" : "[ ]";
    lines.push(`- ${marker} ${s.step} (${s.status})`);
  }
  return lines.join("\n");
}
