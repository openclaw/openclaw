import {
  activeExecRequestOwners,
  cancelExecRequestOwners,
  execRequestMatches,
  readExecRequestOwners,
  type ExecRequestIdentity,
} from "../infra/exec-request-context.js";
import {
  consumeSelectedSystemEventEntries,
  peekExecRequestSystemEventEntries,
} from "../infra/system-events.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  removeNotifyOnExit,
  getSession,
  listExecSessionsForCancellation,
  waitForExecSession,
  type ProcessSession,
} from "./bash-process-registry.js";

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

/** Select before awaited cancellation work; a later human turn cannot enter this plan. */
export function captureExecRequestCancellation(
  target: ExecRequestIdentity,
  accept: (identity: ExecRequestIdentity) => boolean = () => true,
) {
  const queued = peekExecRequestSystemEventEntries(target);
  const initialSessions = listExecSessionsForCancellation();
  const residualOwners = [
    ...initialSessions.flatMap((session) =>
      !session.exited || session.finalizing ? (readExecRequestOwners(session) ?? []) : [],
    ),
    ...queued.flatMap(({ events }) =>
      events.flatMap((event) => readExecRequestOwners(event) ?? []),
    ),
  ].filter((owner) => execRequestMatches(owner, target) && accept(owner.identity));
  const owners = new Set([...activeExecRequestOwners(target, accept), ...residualOwners]);
  const matching = (session: ProcessSession) =>
    readExecRequestOwners(session)?.some((owner) => owners.has(owner)) === true;
  const capturedSessions = initialSessions.filter(matching);
  let cancelled = false;
  return {
    owners: [...owners],
    // Ancestry selects descendants without rewriting completed model receipts.
    requestRunIds: [...new Set([...owners].flatMap((owner) => Array.from(owner.turnRunIds)))],
    cancel() {
      if (cancelled || owners.size === 0) {
        return false;
      }
      cancelled = true;
      cancelExecRequestOwners([...owners]);
      for (const session of listExecSessionsForCancellation().filter(matching)) {
        removeNotifyOnExit(session);
      }
      for (const { sessionKey, events } of queued) {
        consumeSelectedSystemEventEntries(
          sessionKey,
          events.filter((event) =>
            readExecRequestOwners(event)?.some((owner) => owners.has(owner)),
          ),
        );
      }
      return true;
    },
    async settle() {
      const stoppedOwners = new Set([...owners].filter((owner) => owner.signal.aborted));
      if (stoppedOwners.size === 0) {
        return;
      }
      // Accepted Stop may reach the owner through another cancellation path. Keep
      // captured records even if output eviction precedes this cleanup verdict.
      const sessions = [
        ...new Set([...capturedSessions, ...listExecSessionsForCancellation()]),
      ].filter((session) =>
        readExecRequestOwners(session)?.some((owner) => stoppedOwners.has(owner)),
      );
      const pending = sessions.map(waitForExecSession);
      for (const owner of stoppedOwners) {
        for (const settlement of owner.pendingProcesses) {
          pending.push(settlement);
        }
      }
      await Promise.all(pending);
      if (
        [...stoppedOwners].some((owner) => owner.cleanupUncertain) ||
        sessions.some((session) => session.finalizationFailed || session.cleanupUncertain)
      ) {
        throw new Error(
          "Request stopped, but command cleanup could not be confirmed. Inspect its retained process output before retrying.",
        );
      }
    },
  };
}
