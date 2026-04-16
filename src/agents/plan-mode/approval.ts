/**
 * Plan-mode approval state machine.
 *
 * After the agent calls `exit_plan_mode`, the runtime emits a
 * `plan_approval_requested` event. Channel plugins render inline
 * buttons (Approve / Edit / Reject). This module manages the
 * approval lifecycle and resolves the result.
 */

import type { PlanModeSessionState } from "./types.js";

export interface PlanApprovalConfig {
  /** Seconds before auto-rejecting an unanswered approval. Default: 600 (10 min). */
  approvalTimeoutSeconds: number;
}

export const DEFAULT_APPROVAL_CONFIG: PlanApprovalConfig = {
  approvalTimeoutSeconds: 600,
};

/**
 * Resolves a plan approval action into the next session state.
 */
export function resolvePlanApproval(
  current: PlanModeSessionState,
  action: "approve" | "edit" | "reject" | "timeout",
): PlanModeSessionState {
  const now = Date.now();

  switch (action) {
    case "approve":
      return {
        ...current,
        mode: "normal",
        approval: "approved",
        confirmedAt: now,
        updatedAt: now,
      };

    case "edit":
      // Re-enter plan mode with the edited plan. Clear confirmedAt
      // so the previous approval timestamp doesn't leak into the new cycle.
      return {
        ...current,
        mode: "plan",
        approval: "edited",
        confirmedAt: undefined,
        updatedAt: now,
      };

    case "reject":
      return {
        ...current,
        mode: "normal",
        approval: "rejected",
        updatedAt: now,
      };

    case "timeout":
      return {
        ...current,
        mode: "normal",
        approval: "timed_out",
        updatedAt: now,
      };

    default: {
      const _exhaustive: never = action;
      return current;
    }
  }
}

/**
 * Builds the system message injected after plan approval.
 * This tells the agent to execute the approved plan without re-planning.
 */
export function buildApprovedPlanInjection(planSteps: string[]): string {
  const stepList = planSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return (
    "The user has approved the following plan. Execute it now without re-planning. " +
    "If a step is no longer viable, mark it cancelled and add a revised step.\n\n" +
    stepList
  );
}
