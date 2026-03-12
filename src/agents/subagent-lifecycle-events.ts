export const SUBAGENT_TARGET_KIND_SUBAGENT = "subagent" as const;
export const SUBAGENT_TARGET_KIND_ACP = "acp" as const;

export type SubagentLifecycleTargetKind =
  | typeof SUBAGENT_TARGET_KIND_SUBAGENT
  | typeof SUBAGENT_TARGET_KIND_ACP;

export const SUBAGENT_ENDED_REASON_COMPLETE = "subagent-complete" as const;
export const SUBAGENT_ENDED_REASON_ERROR = "subagent-error" as const;
export const SUBAGENT_ENDED_REASON_KILLED = "subagent-killed" as const;
export const SUBAGENT_ENDED_REASON_SESSION_RESET = "session-reset" as const;
export const SUBAGENT_ENDED_REASON_SESSION_DELETE = "session-delete" as const;

export type SubagentLifecycleEndedReason =
  | typeof SUBAGENT_ENDED_REASON_COMPLETE
  | typeof SUBAGENT_ENDED_REASON_ERROR
  | typeof SUBAGENT_ENDED_REASON_KILLED
  | typeof SUBAGENT_ENDED_REASON_SESSION_RESET
  | typeof SUBAGENT_ENDED_REASON_SESSION_DELETE;

export type SubagentSessionLifecycleEndedReason =
  | typeof SUBAGENT_ENDED_REASON_SESSION_RESET
  | typeof SUBAGENT_ENDED_REASON_SESSION_DELETE;

export const SUBAGENT_ENDED_OUTCOME_OK = "ok" as const;
export const SUBAGENT_ENDED_OUTCOME_ERROR = "error" as const;
export const SUBAGENT_ENDED_OUTCOME_TIMEOUT = "timeout" as const;
export const SUBAGENT_ENDED_OUTCOME_KILLED = "killed" as const;
export const SUBAGENT_ENDED_OUTCOME_RESET = "reset" as const;
export const SUBAGENT_ENDED_OUTCOME_DELETED = "deleted" as const;

export type SubagentLifecycleEndedOutcome =
  | typeof SUBAGENT_ENDED_OUTCOME_OK
  | typeof SUBAGENT_ENDED_OUTCOME_ERROR
  | typeof SUBAGENT_ENDED_OUTCOME_TIMEOUT
  | typeof SUBAGENT_ENDED_OUTCOME_KILLED
  | typeof SUBAGENT_ENDED_OUTCOME_RESET
  | typeof SUBAGENT_ENDED_OUTCOME_DELETED;

export function resolveSubagentSessionEndedOutcome(
  reason: SubagentSessionLifecycleEndedReason,
): SubagentLifecycleEndedOutcome {
  if (reason === SUBAGENT_ENDED_REASON_SESSION_RESET) {
    return SUBAGENT_ENDED_OUTCOME_RESET;
  }
  return SUBAGENT_ENDED_OUTCOME_DELETED;
}
