import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

/**
 * Token-pressure facts captured at the point a model turn can no longer safely
 * continue. The thrown signal carries these numbers to cleanup/reporting code
 * without rerunning prompt rendering after the failure.
 */
export type MidTurnPrecheckRequest = {
  route: Exclude<PreemptiveCompactionRoute, "fits">;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

export const MID_TURN_PRECHECK_ERROR_MESSAGE =
  "Context overflow: prompt too large for the model (mid-turn precheck).";

/**
 * Intentional control-flow error for mid-turn context overflow. It stays typed
 * as a signal so outer attempt handling can distinguish policy-driven overflow
 * from provider/runtime failures.
 */
export class MidTurnPrecheckSignal extends Error {
  readonly request: MidTurnPrecheckRequest;

  constructor(request: MidTurnPrecheckRequest) {
    super(MID_TURN_PRECHECK_ERROR_MESSAGE);
    this.name = "MidTurnPrecheckSignal";
    this.request = request;
  }
}

/** Narrows unknown errors before the attempt runner reads precheck metrics. */
export function isMidTurnPrecheckSignal(error: unknown): error is MidTurnPrecheckSignal {
  return error instanceof MidTurnPrecheckSignal;
}
