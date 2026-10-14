export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type EmbeddedRunCompletionCheck = {
  unfinishedPlan: boolean;
  checked: boolean;
};

export type EmbeddedRunTerminalRetryState = {
  completionCheck?: EmbeddedRunCompletionCheck;
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  beforeFinalizeRevisionAttempts: number;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    completionCheck: { unfinishedPlan: false, checked: false },
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    beforeFinalizeRevisionAttempts: 0,
  };
}
