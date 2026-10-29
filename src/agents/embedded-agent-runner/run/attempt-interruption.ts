import type { DiagnosticRunInterruption } from "../../../infra/diagnostic-events.js";
import { isGatewayRestartDrainError } from "../../../process/gateway-work-admission.js";
import {
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../../run-termination.js";
import type { EmbeddedAttemptExecutionState } from "./types.js";

export type AttemptInterruptionState = Pick<
  EmbeddedAttemptExecutionState,
  "terminal" | "diagnosticInterruption"
>;

export function resolveEmbeddedAttemptAbortCause(
  reason: unknown,
  fallback: "external_signal" | "runtime_abort" | "yield_cleanup",
): DiagnosticRunInterruption["abortCause"] {
  return isAgentRunRestartAbortReason(reason) || isGatewayRestartDrainError(reason)
    ? "restart"
    : isAgentRunSupersededAbortReason(reason)
      ? "superseded"
      : isAgentRunDirectAbortReason(reason)
        ? "user_abort"
        : fallback;
}

/** Record before callbacks: terminal precedence may refine status after the initiating abort. */
export function recordEmbeddedAttemptInterruption(
  state: AttemptInterruptionState,
  abortCause: DiagnosticRunInterruption["abortCause"],
  timeout?: Pick<DiagnosticRunInterruption, "timeoutPhase" | "timeoutSource">,
): void {
  if (state.diagnosticInterruption) {
    return;
  }
  const terminal = state.terminal;
  state.diagnosticInterruption = {
    abortCause,
    ...(abortCause === "timeout"
      ? (timeout ??
        (terminal.kind === "timeout" && terminal.source !== "observation"
          ? { timeoutPhase: terminal.phase, timeoutSource: terminal.source }
          : {}))
      : {}),
  };
}
