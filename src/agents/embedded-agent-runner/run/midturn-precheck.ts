import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

/** Snapshot passed from the tool-result guard when a mid-turn prompt would overflow. */
export type MidTurnPrecheckRequest = {
  route: Exclude<PreemptiveCompactionRoute, "fits">;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

/** Stable persisted/runtime error text used to identify mid-turn overflow recovery. */
export const MID_TURN_PRECHECK_ERROR_MESSAGE =
  "Context overflow: prompt too large for the model (mid-turn precheck).";

/** Error signal used to short-circuit the current provider turn for preflight recovery. */
export class MidTurnPrecheckSignal extends Error {
  readonly request: MidTurnPrecheckRequest;

  constructor(request: MidTurnPrecheckRequest) {
    super(MID_TURN_PRECHECK_ERROR_MESSAGE);
    this.name = "MidTurnPrecheckSignal";
    this.request = request;
  }
}

/** Narrows errors thrown by mid-turn precheck before retry/compaction handling. */
export function isMidTurnPrecheckSignal(error: unknown): error is MidTurnPrecheckSignal {
  return error instanceof MidTurnPrecheckSignal;
}
