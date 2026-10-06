import { getProcessSupervisor } from "../process/supervisor/index.js";
import { getSession, type ProcessSession } from "./bash-process-registry.js";

export function isBackgroundExecCancellable(
  session: ProcessSession | undefined,
): session is ProcessSession {
  return Boolean(
    session?.backgrounded &&
    !session.exited &&
    !session.finalizing &&
    session.processActivity &&
    !session.processActivity.resultSettled,
  );
}

export function cancelBackgroundExecSession(sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!isBackgroundExecCancellable(session)) {
    return false;
  }
  const supervisor = getProcessSupervisor();
  supervisor.cancel(sessionId, "manual-cancel");
  session.cancellationRequested = true;
  return true;
}

/** A requested cancellation is successful only after its own terminal reason and cleanup. */
export function isConfirmedRequestedStop(session: ProcessSession): boolean {
  return (
    session.cancellationRequested === true &&
    session.exitReason === "manual-cancel" &&
    session.finalizationFailed !== true
  );
}
