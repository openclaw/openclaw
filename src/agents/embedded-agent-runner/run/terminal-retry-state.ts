import type { EmbeddedRunAttemptResult } from "./types.js";

export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  settledToolContinuationAttempts: number;
  pendingSettledToolFinalization: EmbeddedRunAttemptResult | null;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    settledToolContinuationAttempts: 0,
    pendingSettledToolFinalization: null,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
  };
}
