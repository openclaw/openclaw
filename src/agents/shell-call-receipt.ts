import { getInternalToolResultProvenance } from "../../packages/agent-core/src/internal-hooks.js";
import {
  bindShellResultObservation,
  type ShellCallReceipt,
} from "../config/sessions/transcript-shell-receipt.js";
import type { ProcessSession } from "./bash-process-registry.js";
import type { ExecToolDetails } from "./bash-tools.exec-result.types.js";

const processReceipts = new WeakMap<ProcessSession, ShellCallReceipt>();

export function bindShellProcess(
  session: ProcessSession,
  receipt: ShellCallReceipt | undefined,
): void {
  if (receipt) {
    processReceipts.set(session, receipt);
  }
}

// The registry retains the exact same object after exit. A reused public process id
// or a poll from a different run cannot attribute an effect to this invocation.
export function markShellPollResult<T extends object>(
  result: T,
  session: ProcessSession,
  pollCallId: string,
): T {
  const receipt = processReceipts.get(session);
  if (receipt && hasObservedExit(session) && isShellCleanupCertain(session)) {
    return bindShellResultObservation(result, { ...receipt, callId: pollCallId });
  }
  return result;
}

export function isShellCleanupCertain(
  session: Pick<ProcessSession, "cleanupUncertain" | "finalizationFailed">,
): boolean {
  return !session.cleanupUncertain && !session.finalizationFailed;
}

export function hasObservedExit<
  T extends {
    exitCode?: number | null;
    exitReason?: string;
    exitSignal?: string | number | null;
    noOutputTimedOut?: boolean;
  },
>(result: T): result is T & { exitCode: number } {
  // Remote nodes may report only an exit code. When the supervisor has a cause,
  // a kill, cancellation or memory limit cannot establish the command's effect.
  return (
    typeof result.exitCode === "number" &&
    (!result.exitReason || result.exitReason === "exit") &&
    !result.exitSignal &&
    !result.noOutputTimedOut
  );
}

/** Only the native shell can bind an observed process result to its pre-dispatch identity. */
export function markShellCallResult<T extends { details: ExecToolDetails }>(
  result: T,
  receipt: ShellCallReceipt | undefined,
  session?: ProcessSession,
): T {
  const detail = result.details;
  if (
    receipt &&
    // The root can exit normally while the process owner still cannot confirm its descendants stopped.
    (!session || isShellCleanupCertain(session)) &&
    !getInternalToolResultProvenance(result) &&
    (detail.status === "completed" || detail.status === "failed") &&
    (detail.reason === "not-dispatched" ||
      detail.reason === "permission-missing" ||
      detail.reason === "policy-denied" ||
      (detail.reason !== "outcome-unknown" && !detail.timedOut && hasObservedExit(detail)))
  ) {
    return bindShellResultObservation(result, receipt);
  }
  return result;
}
