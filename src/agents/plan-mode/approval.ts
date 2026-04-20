/**
 * Plan-mode approval state machine.
 *
 * After the agent calls `exit_plan_mode`, the runtime emits a
 * `plan_approval_requested` event. Channel plugins render inline
 * buttons (Approve / Edit / Reject). This module manages the
 * approval lifecycle and resolves the result.
 *
 * ## Rejection UX (Decision 4)
 *
 * On rejection, mode stays "plan" (fail-closed). The agent receives
 * a structured [PLAN_DECISION] injection at the start of its next
 * turn with the user's feedback. The agent revises and calls
 * update_plan again. No hard limit on cycles; after 3 rejections
 * the injection suggests asking the user to clarify their goal.
 *
 * On edit, the user's edits count as approval — mode transitions
 * to "normal" and the agent executes the edited plan.
 *
 * On timeout, mode stays "plan". The agent is told the proposal
 * expired and may re-propose when the user returns.
 */

import type { PlanModeSessionState } from "./types.js";

export interface PlanApprovalConfig {
  /** Seconds before an unanswered approval expires. Default: 600 (10 min). */
  approvalTimeoutSeconds: number;
}

export const DEFAULT_APPROVAL_CONFIG: PlanApprovalConfig = {
  approvalTimeoutSeconds: 600,
};

/**
 * Resolves a plan approval action into the next session state.
 *
 * @param feedback - Optional user feedback on rejection
 * @param expectedApprovalId - Optional version token from the approval event.
 *   If provided and doesn't match `current.approvalId`, the action is ignored
 *   as stale (e.g. user clicks Approve on a plan that was already rejected
 *   and revised on another surface).
 */
export function resolvePlanApproval(
  current: PlanModeSessionState,
  action: "approve" | "edit" | "reject" | "timeout",
  feedback?: string,
  expectedApprovalId?: string,
): PlanModeSessionState {
  const now = Date.now();

  // Stale-event guard: if the caller provided an approvalId, the current
  // state MUST have a matching approvalId. Mismatch — or, importantly,
  // current state having no approvalId at all when one is expected — means
  // the event is stale (e.g. user clicked Approve on a plan that was
  // already approved/rejected and the state moved on). No-op.
  //
  // Earlier draft only no-op'd when both sides had defined IDs and they
  // differed, which left a fail-open: an attacker (or stale UI) could
  // supply expectedApprovalId and have it accepted whenever the current
  // state happened to have a cleared/undefined approvalId.
  if (expectedApprovalId !== undefined) {
    if (current.approvalId === undefined || expectedApprovalId !== current.approvalId) {
      return current;
    }
  }

  // Terminal-state guard. Approved, edited, and timed_out are terminal —
  // they require a fresh exit_plan_mode call (which mints a new approvalId)
  // before any new action can apply. Rejected stays open for re-approval
  // or re-rejection.
  if (
    current.approval !== "pending" &&
    current.approval !== "rejected" &&
    current.approval !== "none"
  ) {
    return current;
  }
  if (action === "timeout" && current.approval !== "pending") {
    return current;
  }

  switch (action) {
    case "approve":
      // Approve clears feedback AND resets rejectionCount — the user is
      // moving forward, so cycle history is no longer relevant.
      return {
        ...current,
        mode: "normal",
        approval: "approved",
        confirmedAt: now,
        updatedAt: now,
        feedback: undefined,
        rejectionCount: 0,
      };

    case "edit":
      // Edit counts as approval — same reset behavior as approve.
      return {
        ...current,
        mode: "normal",
        approval: "edited",
        confirmedAt: now,
        updatedAt: now,
        feedback: undefined,
        rejectionCount: 0,
      };

    case "reject":
      return {
        ...current,
        mode: "plan",
        approval: "rejected",
        confirmedAt: undefined,
        updatedAt: now,
        feedback: feedback ?? current.feedback,
        rejectionCount: (current.rejectionCount ?? 0) + 1,
      };

    case "timeout":
      return {
        ...current,
        mode: "plan",
        approval: "timed_out",
        confirmedAt: undefined,
        updatedAt: now,
        feedback: undefined,
      };

    default: {
      const _exhaustive: never = action;
      return current;
    }
  }
}

/**
 * Builds the context injection for an approved plan.
 * Tells the agent to execute the approved plan without re-planning.
 */
export function buildApprovedPlanInjection(planSteps: string[]): string {
  const stepList = planSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return (
    "The user has approved the following plan. Execute it now without re-planning. " +
    "Do not re-plan unless necessary. " +
    "If a step is no longer viable, mark it cancelled and add a revised step.\n\n" +
    // PR #68939 follow-up (plan-completion enforcement): agents have
    // been observed going idle after sub-operations return (e.g.,
    // subagent returns its result, write succeeds, etc.) without
    // marking the driving plan step as `completed`. Post-approval
    // nudges don't fire (they're plan-mode-bound; session is now in
    // mode:"normal"), so the reminder has to be inline in the
    // approval injection itself. This is a soft steer — reinforced
    // by update_plan's merge semantics and the close-on-complete
    // detector in plan-snapshot-persister.ts — not a hard gate.
    "Check and record the planned status for each step as you go. " +
    "After each step finishes (successful or not), call `update_plan` to mark " +
    'that step\'s status as "completed" or "cancelled". The plan is not done ' +
    "until every step is recorded as completed or cancelled.\n\n" +
    "The approved plan:\n\n" +
    stepList
  );
}
