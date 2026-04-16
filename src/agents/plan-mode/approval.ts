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
 */
export function resolvePlanApproval(
  current: PlanModeSessionState,
  action: "approve" | "edit" | "reject" | "timeout",
  feedback?: string,
): PlanModeSessionState {
  const now = Date.now();

  // Ignore stale timeouts when approval is already resolved, and ignore
  // actions on terminal states (approved, edited, timed_out). Rejected
  // state can transition to approve/edit (user changes mind) or reject
  // again (revised feedback).
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
      return {
        ...current,
        mode: "normal",
        approval: "approved",
        confirmedAt: now,
        updatedAt: now,
        feedback: undefined,
      };

    case "edit":
      // User's edits count as approval — transition to execute mode.
      return {
        ...current,
        mode: "normal",
        approval: "edited",
        confirmedAt: now,
        updatedAt: now,
        feedback: undefined,
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
    "If a step is no longer viable, mark it cancelled and add a revised step.\n\n" +
    stepList
  );
}
