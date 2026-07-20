export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  toolUseContinuationAttempts: number;
  postToolEmptyFinalizerAttempts: number;
  /**
   * When true, the next prepared attempt must run with tools disabled. Armed by
   * the post-tool empty finalizer so a summary retry cannot re-fire side effects.
   * Cleared once consumed by attempt dispatch.
   */
  disableToolsForNextAttempt: boolean;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    toolUseContinuationAttempts: 0,
    postToolEmptyFinalizerAttempts: 0,
    disableToolsForNextAttempt: false,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
  };
}
