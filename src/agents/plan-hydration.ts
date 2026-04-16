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

import type { PlanStepStatus } from "./tools/update-plan-tool.js";

/**
 * Plan step shape accepted by hydration. `status` stays widened to
 * `string` because hydration consumes data from heterogeneous sources
 * (compaction snapshots, channel adapters, JSON imports) where the
 * value is not always pre-narrowed to `PlanStepStatus`. Valid statuses
 * are listed in `PLAN_STEP_STATUSES`; unknown statuses are filtered out
 * by the active-set check below.
 */
interface PlanStep {
  step: string;
  status: string;
  activeForm?: string;
}

// Active statuses (pending + in_progress) are the subset we replay after
// compression. The literal tuple is asserted via `satisfies` so this
// file fails to compile if `PlanStepStatus` ever drops one of these
// names. The Set is typed `string` so `.has()` accepts the widened
// input from heterogeneous callers without a cast.
const ACTIVE_PLAN_STATUSES = [
  "pending",
  "in_progress",
] as const satisfies readonly PlanStepStatus[];
const ACTIVE_STATUSES: ReadonlySet<string> = new Set<string>(ACTIVE_PLAN_STATUSES);

/**
 * Formats active plan steps for injection after compaction.
 * Returns `null` if there are no active steps to preserve.
 *
 * Matches Hermes's format_for_injection() output:
 *   [Your active plan was preserved across context compression]
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
