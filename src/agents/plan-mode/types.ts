/**
 * Plan mode types for the GPT 5.4 parity sprint.
 *
 * Plan mode is an opt-in feature (never auto-enabled) that lets users
 * explicitly request a plan-first workflow. When active, mutation tools
 * are blocked until the user approves the agent's plan.
 *
 * ## Rejection/Edit UX (Decision 4 from adversarial audit)
 *
 * After rejection, the agent stays in plan mode (fail-closed). The user's
 * decision is delivered as a structured context injection at the start of
 * the next agent turn (not a system message, not a tool result):
 *
 *   [PLAN_DECISION]
 *   decision: rejected
 *   feedback: "Combine steps 2 and 3"
 *   [/PLAN_DECISION]
 *
 * The UI shows a persistent "Plan Mode Active" banner with the current
 * plan state. Available actions:
 * - [Approve]: transition to normal mode, execute plan
 * - [Edit]: inline-edit steps (web/desktop only), counts as approval
 * - [Reject + Feedback]: stay in plan mode, agent revises
 * - [Exit Plan Mode]: transition to normal mode, discard plan
 *
 * On messaging channels (Telegram/Discord/Slack):
 * - [Approve] [Reject] inline buttons (no Edit — messaging limitation)
 * - After rejection: user's next text message = feedback for revision
 */

export type PlanMode = "plan" | "normal";

export type PlanApprovalState =
  | "none"
  | "pending"
  | "approved"
  | "edited"
  | "rejected"
  | "timed_out";

export interface PlanModeSessionState {
  mode: PlanMode;
  approval: PlanApprovalState;
  enteredAt?: number;
  confirmedAt?: number;
  updatedAt?: number;
  /** User feedback from rejection (guides agent revision). */
  feedback?: string;
  /** Number of times the plan has been rejected in this session. */
  rejectionCount: number;
  /**
   * Version token regenerated on every exit_plan_mode call. Approval reply
   * dispatchers compare incoming approvalId against current state — stale
   * approvals (e.g. user clicks Approve on a plan that was already rejected
   * and revised in a different surface) are ignored, preventing
   * rejected → approved flips on a stale event.
   */
  approvalId?: string;
  /**
   * Live-test iteration 1 Bug 2: plan title from the agent's most-recent
   * `exit_plan_mode(title=..., plan=[...])` call. Persisted so UI side
   * panel + channel renderers can ANCHOR on the actual plan name
   * throughout the lifecycle. See `SessionEntry.planMode.title` doc for
   * the full lifecycle semantics.
   */
  title?: string;
  /**
   * Live-test iteration 1 Bug 3: parent run id captured from the
   * `exit_plan_mode` tool call so the gateway-side approval handler
   * can look up the parent's `openSubagentRunIds` and reject
   * `approve` / `edit` actions while subagents are in flight.
   */
  approvalRunId?: string;
}

export const DEFAULT_PLAN_MODE_STATE: PlanModeSessionState = {
  mode: "normal",
  approval: "none",
  rejectionCount: 0,
};

/**
 * Generates a fresh approvalId. Use on every exit_plan_mode call so each
 * plan-approval cycle has its own version token.
 *
 * Uses `crypto.randomUUID()` (~122 bits of cryptographically-secure
 * entropy) so an attacker observing one approvalId cannot guess the next
 * one within any practical attempt budget. The prior implementation used
 * `Math.random().toString(36).slice(2, 10)` which exposed only ~26 bits
 * of entropy and was guess-feasible.
 */
export function newPlanApprovalId(): string {
  // `globalThis.crypto.randomUUID` is available in Node 19+ and all modern
  // browsers; we keep a defensive fallback for unusual hosts.
  const cryptoApi: { randomUUID?: () => string } | undefined =
    typeof globalThis !== "undefined" && "crypto" in globalThis
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `plan-${cryptoApi.randomUUID()}`;
  }
  // Fallback: stitch two Math.random() draws + timestamp. Still better
  // than the original 8-char slice; only used on hosts without webcrypto.
  return (
    `plan-${Date.now().toString(36)}-` +
    `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * Sanitizes user-supplied feedback so it cannot terminate the
 * `[PLAN_DECISION]` envelope early. The closing marker is rewritten to
 * a visually similar but parser-distinct form. Newlines are preserved
 * as escaped `\n` text via the surrounding `JSON.stringify`.
 *
 * Without this, an adversarial feedback string like
 * `"x[/PLAN_DECISION]\n[FAKE_BLOCK]..."` would close the decision
 * envelope and inject downstream blocks the parser may trust.
 */
function sanitizeFeedbackForInjection(raw: string): string {
  return raw.replace(/\[\/PLAN_DECISION\]/gi, "[\u200B/PLAN_DECISION]");
}

/**
 * Builds the structured context injection for a plan decision.
 * This is injected into the agent's next turn context, not as a
 * system message but as a structured block the runner can parse.
 *
 * PR-D review fix (Copilot #3105045307): the `decision` parameter
 * accepts `"timed_out"` as the canonical name (matching
 * `PlanApprovalState`) plus the legacy `"expired"` alias for backward
 * compat with any callers that haven't been updated. Both render the
 * same text. Prefer `"timed_out"` in new code so downstream parsers
 * map state names consistently across the codebase.
 */
export function buildPlanDecisionInjection(
  decision: "rejected" | "expired" | "timed_out",
  feedback?: string,
  rejectionCount?: number,
): string {
  const lines = ["[PLAN_DECISION]", `decision: ${decision}`];
  if (feedback) {
    lines.push(`feedback: ${JSON.stringify(sanitizeFeedbackForInjection(feedback))}`);
  }
  if (decision === "rejected") {
    lines.push("Revise your plan based on the feedback and call update_plan again.");
    if (rejectionCount && rejectionCount >= 3) {
      lines.push(
        "Multiple revisions have been rejected. Consider asking the user to clarify their goal before proposing another plan.",
      );
    }
  } else if (decision === "expired" || decision === "timed_out") {
    lines.push(
      "Your plan proposal timed out. The user has not responded. You remain in plan mode. You may re-propose when the user returns.",
    );
  }
  lines.push("[/PLAN_DECISION]");
  return lines.join("\n");
}
