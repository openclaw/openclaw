import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  GOAL_CONTINUATION_DELAY_MS,
  GOAL_LEASE_KEY,
  GOAL_MAX_CONTINUATIONS,
  type GoalState,
  type GoalStore,
  type GoalStatus,
  updateGoalState,
} from "./state.js";

export type GoalWorkflowDeps = Pick<
  OpenClawPluginApi["session"]["workflow"],
  "clearSessionContinuationLease" | "requestSessionContinuationLease"
>;

export function isStopStatus(status: GoalStatus): boolean {
  return status !== "continue";
}

export function buildGoalContinuationMessage(state: GoalState): string {
  return [
    "Continue the active session goal.",
    `Objective: ${state.objective}`,
    "Work until a useful next slice is complete, then call goal_status with status continue, done, blocked, paused, or waiting_approval.",
  ].join("\n");
}

export async function applyGoalStatus(params: {
  store: GoalStore;
  workflow: GoalWorkflowDeps;
  session: { sessionKey?: string };
  state: GoalState;
  status: GoalStatus;
  note?: string;
}): Promise<GoalState> {
  if (isStopStatus(params.status)) {
    await params.workflow.clearSessionContinuationLease({
      session: params.session,
      leaseKey: GOAL_LEASE_KEY,
    });
    const next = updateGoalState(params.state, {
      status: params.status,
      note: params.note,
      continuationScheduled: false,
    });
    await params.store.write(next);
    return next;
  }

  if (params.state.continuationCount >= GOAL_MAX_CONTINUATIONS) {
    await params.workflow.clearSessionContinuationLease({
      session: params.session,
      leaseKey: GOAL_LEASE_KEY,
    });
    const next = updateGoalState(params.state, {
      status: "waiting_approval",
      note:
        params.note ??
        `Continuation limit reached (${GOAL_MAX_CONTINUATIONS}); start a new goal to continue.`,
      continuationScheduled: false,
    });
    await params.store.write(next);
    return next;
  }

  const lease = await params.workflow.requestSessionContinuationLease({
    session: params.session,
    leaseKey: GOAL_LEASE_KEY,
    message: buildGoalContinuationMessage(params.state),
    delayMs: GOAL_CONTINUATION_DELAY_MS,
    deliveryMode: "none",
  });
  const next = updateGoalState(params.state, {
    status: "continue",
    note: params.note,
    continuationScheduled: lease.scheduled,
  });
  await params.store.write(next);
  return next;
}
