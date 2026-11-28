import type { ContextPressure } from "../../context-pressure.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

/**
 * Captures the token-pressure snapshot that made the mid-turn tool-result guard
 * stop the attempt before another model call.
 */
export type MidTurnPrecheckRequest = {
  /** Only "overflow" may fail the turn; "maintenance" always continues it. */
  pressure: ContextPressure;
  route: Exclude<PreemptiveCompactionRoute, "fits">;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

/** Stable messages used to identify synthetic mid-turn signals in session cleanup. */
const MID_TURN_PRECHECK_ERROR_MESSAGE =
  "Context overflow: prompt too large for the model (mid-turn precheck).";
const MID_TURN_MAINTENANCE_MESSAGE = "Context maintenance scheduled at a settled tool boundary.";

/**
 * Internal control-flow signal thrown after a tool result makes the next prompt
 * exceed budget. The attempt runner catches it and routes through the overflow
 * recovery path instead of treating it as an ordinary provider failure.
 */
export class MidTurnPrecheckSignal extends Error {
  readonly request: MidTurnPrecheckRequest;

  constructor(request: MidTurnPrecheckRequest) {
    super(
      request.pressure === "overflow"
        ? MID_TURN_PRECHECK_ERROR_MESSAGE
        : MID_TURN_MAINTENANCE_MESSAGE,
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
      message.errorMessage === MID_TURN_MAINTENANCE_MESSAGE)
  );
}

/** Maintenance is not a failure; lifecycle observers must not report it as one. */
export function isMidTurnMaintenanceAssistantSignal(message: AgentMessage | undefined): boolean {
  return (
    message?.role === "assistant" &&
    message.stopReason === "error" &&
    message.errorMessage === MID_TURN_MAINTENANCE_MESSAGE
  );
}
