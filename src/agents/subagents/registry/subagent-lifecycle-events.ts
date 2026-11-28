import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";

export const SUBAGENT_TARGET_KIND_SUBAGENT = "subagent" as const;

export const SUBAGENT_ENDED_REASON_COMPLETE = "subagent-complete" as const;
export const SUBAGENT_ENDED_REASON_ERROR = "subagent-error" as const;
export const SUBAGENT_ENDED_REASON_GATEWAY_RESTART = "gateway-restart" as const;
export const SUBAGENT_ENDED_REASON_KILLED = "subagent-killed" as const;

export type SubagentLifecycleEndedReason =
  | typeof SUBAGENT_ENDED_REASON_COMPLETE
  | typeof SUBAGENT_ENDED_REASON_ERROR
  | typeof SUBAGENT_ENDED_REASON_GATEWAY_RESTART
  | typeof SUBAGENT_ENDED_REASON_KILLED;

export function subagentWorkerOutcomeStatus(
  reason: SubagentLifecycleEndedReason | undefined,
  outcome: SubagentRunOutcome | undefined,
) {
  return reason === SUBAGENT_ENDED_REASON_GATEWAY_RESTART
    ? "unknown"
    : (outcome?.status ?? "unknown");
}

export const SUBAGENT_ENDED_OUTCOME_OK = "ok" as const;
export const SUBAGENT_ENDED_OUTCOME_ERROR = "error" as const;
export const SUBAGENT_ENDED_OUTCOME_TIMEOUT = "timeout" as const;
export const SUBAGENT_ENDED_OUTCOME_KILLED = "killed" as const;

export type SubagentLifecycleEndedOutcome =
  | typeof SUBAGENT_ENDED_OUTCOME_OK
  | typeof SUBAGENT_ENDED_OUTCOME_ERROR
  | typeof SUBAGENT_ENDED_OUTCOME_TIMEOUT
  | typeof SUBAGENT_ENDED_OUTCOME_KILLED;
