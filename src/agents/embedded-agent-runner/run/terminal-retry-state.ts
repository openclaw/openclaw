import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type EmbeddedRunCompletionCheck = {
  work: import("../../../session-cards/progress-card-work-intent.js").WorkSnapshot;
  refresh?: () => Promise<
    import("../../../session-cards/progress-card-work-intent.js").WorkSnapshot
  >;
  checked: boolean;
};

export type EmbeddedRunTerminalRetryState = {
  completionCheck?: EmbeddedRunCompletionCheck;
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  textToolCallAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  beforeFinalizeRevisionAttempts: number;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    completionCheck: {
      work: { kind: "unavailable", reason: "Retained work has not been observed" },
      checked: false,
    },
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    textToolCallAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    beforeFinalizeRevisionAttempts: 0,
  };
}

export const PROGRESS_WORK_COMPLETION_MESSAGE = {
  customType: "openclaw.plan-completion-check",
  display: false,
  content: `The retained task still has unfinished steps. Before ending, check whether those steps remain required and authorized under the latest user instructions. Continue feasible work from the current transcript; do not repeat completed actions, and reconcile uncertain effects before retrying. If work is complete, explicitly reconcile the retained task. If user input, approval, an external dependency, or an explicit pause prevents further work, report that concrete limitation; if your previous reply already reported it, end with only ${SILENT_REPLY_TOKEN}. Do not invent completion or new authority.`,
};
