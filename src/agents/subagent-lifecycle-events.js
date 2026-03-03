export const SUBAGENT_TARGET_KIND_SUBAGENT = "subagent";
export const SUBAGENT_TARGET_KIND_ACP = "acp";
export const SUBAGENT_ENDED_REASON_COMPLETE = "subagent-complete";
export const SUBAGENT_ENDED_REASON_ERROR = "subagent-error";
export const SUBAGENT_ENDED_REASON_KILLED = "subagent-killed";
export const SUBAGENT_ENDED_REASON_SESSION_RESET = "session-reset";
export const SUBAGENT_ENDED_REASON_SESSION_DELETE = "session-delete";
export const SUBAGENT_ENDED_OUTCOME_OK = "ok";
export const SUBAGENT_ENDED_OUTCOME_ERROR = "error";
export const SUBAGENT_ENDED_OUTCOME_TIMEOUT = "timeout";
export const SUBAGENT_ENDED_OUTCOME_KILLED = "killed";
export const SUBAGENT_ENDED_OUTCOME_RESET = "reset";
export const SUBAGENT_ENDED_OUTCOME_DELETED = "deleted";
export function resolveSubagentSessionEndedOutcome(reason) {
    if (reason === SUBAGENT_ENDED_REASON_SESSION_RESET) {
        return SUBAGENT_ENDED_OUTCOME_RESET;
    }
    return SUBAGENT_ENDED_OUTCOME_DELETED;
}
