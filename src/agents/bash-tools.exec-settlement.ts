import {
  markExited,
  settleExecSessionFinalization,
  type ProcessSession,
} from "./bash-process-registry.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-types.js";

/** Settle the process owner's ledger and notifications before releasing scope joins. */
export async function settleExecProcessExit({
  session,
  outcome,
  onSettledBeforeNotify,
  notifyOnExit,
  failureOutcome,
}: {
  session: ProcessSession;
  outcome: ExecProcessOutcome;
  onSettledBeforeNotify?: (outcome: ExecProcessOutcome) => void | Promise<void>;
  notifyOnExit: (session: ProcessSession, status: "completed" | "failed") => void;
  failureOutcome: (error: unknown) => ExecProcessOutcome;
}): Promise<ExecProcessOutcome> {
  let finalOutcome = outcome;
  // Task and notification failures do not change the observed process exit.
  const {
    exitCode,
    exitSignal,
    status: processStatus,
    exitReason,
    noOutputTimedOut,
  } = finalOutcome;
  const markProcessExited = () =>
    markExited(session, exitCode, exitSignal, processStatus, exitReason, noOutputTimedOut);
  try {
    const shouldNotify = !session.exited;
    const settlement = onSettledBeforeNotify?.(finalOutcome);
    if (settlement instanceof Promise) {
      await settlement;
    }
    if (shouldNotify) {
      markProcessExited();
    }
    if (shouldNotify) {
      notifyOnExit(session, finalOutcome.status);
    }
  } catch (error) {
    session.finalizationFailed = true;
    // Keep the exact process owner through failed-outcome correction, including
    // notification failures after the process moved into completed retention.
    finalOutcome = failureOutcome(error);
    const settlement = onSettledBeforeNotify?.(finalOutcome);
    if (settlement instanceof Promise) {
      await settlement;
    }
  } finally {
    try {
      if (!session.exited) {
        markProcessExited();
      }
    } finally {
      // Notifications need start-time routing, but completed logs must not
      // retain it, including when a task callback or notification throws.
      delete session.sessionKey;
      delete session.agentId;
      delete session.eventRouting;
      delete session.notifyDeliveryContext;
      delete session.notifyOnExit;
      delete session.notifyOnExitEmptySuccess;
      settleExecSessionFinalization(session);
    }
  }
  return finalOutcome;
}
