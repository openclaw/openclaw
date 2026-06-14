/**
 * Shared agent run termination constants.
 *
 * Runtime and stream consumers use these stable literals to recognize user or
 * controller aborts without matching free-form error text.
 */
/** Stop reason emitted when an agent run is aborted. */
export const AGENT_RUN_ABORTED_STOP_REASON = "aborted" as const;
/** Error text used for aborted agent runs. */
export const AGENT_RUN_ABORTED_ERROR = "agent run aborted" as const;
export const AGENT_RUN_RESTART_ABORT_STOP_REASON = "restart" as const;

const AGENT_RUN_RESTART_ABORT_ERROR_CODE = "OPENCLAW_RESTART_ABORT";

export function createAgentRunRestartAbortError(): Error {
  const error = new Error("agent run aborted for restart") as Error & { code: string };
  error.name = "AbortError";
  error.code = AGENT_RUN_RESTART_ABORT_ERROR_CODE;
  return error;
}

export function isAgentRunRestartAbortReason(value: unknown): boolean {
  return (
    value instanceof Error && "code" in value && value.code === AGENT_RUN_RESTART_ABORT_ERROR_CODE
  );
}

export function resolveAgentRunAbortLifecycleFields(signal: AbortSignal | undefined): {
  aborted?: true;
  stopReason?:
    | typeof AGENT_RUN_ABORTED_STOP_REASON
    | typeof AGENT_RUN_RESTART_ABORT_STOP_REASON
    | "timeout";
} {
  if (!signal?.aborted) {
    return {};
  }
  const stopReason = isAgentRunRestartAbortReason(signal.reason)
    ? AGENT_RUN_RESTART_ABORT_STOP_REASON
    : signal.reason &&
        typeof signal.reason === "object" &&
        "name" in signal.reason &&
        signal.reason.name === "TimeoutError"
      ? "timeout"
      : AGENT_RUN_ABORTED_STOP_REASON;
  return {
    aborted: true,
    stopReason,
  };
}

/** Returns whether a stop reason is the stable aborted-run reason. */
export function isAbortedAgentStopReason(
  value: unknown,
): value is typeof AGENT_RUN_ABORTED_STOP_REASON | typeof AGENT_RUN_RESTART_ABORT_STOP_REASON {
  return value === AGENT_RUN_ABORTED_STOP_REASON || value === AGENT_RUN_RESTART_ABORT_STOP_REASON;
}
