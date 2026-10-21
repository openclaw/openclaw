import type { AgentMessage } from "../../runtime/index.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

/**
 * Captures a safe-boundary compaction request and its measured prompt pressure
 * before the attempt submits another model call.
 */
export type MidTurnPrecheckRequest = {
  /** Voluntary compaction is an explicit host request, not fabricated token pressure. */
  requestedCompaction?: import("../../session-maintenance/request.js").SessionCompactionRequest;
  route: Exclude<PreemptiveCompactionRoute, "fits">;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

/** Stable message used to identify synthetic mid-turn overflow errors in session cleanup. */
const MID_TURN_PRECHECK_ERROR_MESSAGE =
  "Context overflow: prompt too large for the model (mid-turn precheck).";
const MODEL_REQUESTED_COMPACTION_MESSAGE =
  "Session compaction requested at a settled tool boundary.";

/**
 * Internal control-flow signal for pressure-driven or model-requested compaction.
 * The attempt releases its tools before the existing run owner compacts and
 * continues; this is never an ordinary provider failure.
 */
export class MidTurnPrecheckSignal extends Error {
  readonly request: MidTurnPrecheckRequest;

  constructor(request: MidTurnPrecheckRequest) {
    super(
      request.requestedCompaction
        ? MODEL_REQUESTED_COMPACTION_MESSAGE
        : MID_TURN_PRECHECK_ERROR_MESSAGE,
    );
    this.name = "MidTurnPrecheckSignal";
    this.request = request;
  }
}

export function isMidTurnPrecheckSignal(error: unknown): error is MidTurnPrecheckSignal {
  return error instanceof MidTurnPrecheckSignal;
}

/** This local routing signal is not a provider response or durable conversation item. */
export function isMidTurnPrecheckAssistantError(message: AgentMessage | undefined): boolean {
  return (
    message?.role === "assistant" &&
    message.stopReason === "error" &&
    (message.errorMessage === MID_TURN_PRECHECK_ERROR_MESSAGE ||
      message.errorMessage === MODEL_REQUESTED_COMPACTION_MESSAGE)
  );
}
