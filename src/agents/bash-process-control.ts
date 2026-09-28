import { getProcessSupervisor } from "../process/supervisor/index.js";
import { getSession } from "./bash-process-registry.js";

export function cancelBackgroundExecSession(sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!session?.backgrounded || session.exited || session.finalizing) {
    return false;
  }
  const supervisor = getProcessSupervisor();
  if (!session.processActivity || session.processActivity.resultSettled) {
    return false;
  }
  supervisor.cancel(sessionId, "manual-cancel");
  session.cancellationRequested = true;
  return true;
}
