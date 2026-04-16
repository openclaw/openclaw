/**
 * Plan mode types for the GPT 5.4 parity sprint.
 *
 * Plan mode is an opt-in feature (never auto-enabled) that lets users
 * explicitly request a plan-first workflow. When active, mutation tools
 * are blocked until the user approves the agent's plan.
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
}

export const DEFAULT_PLAN_MODE_STATE: PlanModeSessionState = {
  mode: "normal",
  approval: "none",
};
