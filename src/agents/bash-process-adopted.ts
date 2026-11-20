import { adoptReleasedProcess } from "../process/supervisor/released-processes.js";
import type { ReleasedProcess } from "../process/supervisor/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createProcessSessionId } from "./bash-process-id.js";
import {
  appendOutput,
  listRunningSessions,
  markExited,
  type ProcessSession,
  registerProcessSession,
} from "./bash-process-registry.js";

/** Declared services (`background: true`) are admitted, never evicted. Survivors are tracked, not counted. */
const MAX_SERVICES_PER_SESSION = 16;
const MAX_SERVICES_PER_GATEWAY = 64;

// Background starts hold a slot from admission until their session is running
// or startup fails, so concurrent starts cannot pass the limit together.
const reservations = resolveGlobalSingleton(
  Symbol.for("openclaw.execServiceReservations"),
  () => new Set<{ scopeKey: string }>(),
);

/** Explain the limit when a new service would cross it; undefined when there is room. */
function serviceCapacityError(scopeKey: string): string | undefined {
  const running = listRunningSessions().filter(
    (session) => session.independentService === true && !session.exited,
  );
  const reserved = [...reservations];
  const inSession =
    running.filter((session) => session.scopeKey === scopeKey).length +
    reserved.filter((reservation) => reservation.scopeKey === scopeKey).length;
  const total = running.length + reserved.length;
  if (inSession < MAX_SERVICES_PER_SESSION && total < MAX_SERVICES_PER_GATEWAY) {
    return undefined;
  }
  return `This session runs ${inSession} of ${MAX_SERVICES_PER_SESSION} allowed services (Gateway: ${total} of ${MAX_SERVICES_PER_GATEWAY}). Use process list to see them and process kill <sessionId> to stop ones you no longer need.`;
}

/**
 * Admit one new service or throw the limit error. Dispose the slot once the
 * service is a running session (it then counts itself) or startup failed.
 */
export function reserveServiceSlot(scopeKey: string, isService = true): Disposable | undefined {
  if (!isService) {
    return undefined;
  }
  const capacityError = serviceCapacityError(scopeKey);
  if (capacityError) {
    throw new Error(`Cannot start another background service. ${capacityError}`);
  }
  const reservation = { scopeKey };
  reservations.add(reservation);
  return {
    [Symbol.dispose]: () => {
      reservations.delete(reservation);
    },
  };
}

function formatProcess({ pid, command }: ReleasedProcess): string {
  return command ? `pid ${pid} (${command})` : `pid ${pid}`;
}

function adoptSurvivor(parent: ProcessSession, survivor: ReleasedProcess) {
  const adopted = adoptReleasedProcess(parent.scopeKey, survivor, () =>
    markExited(
      session,
      null,
      null,
      "completed",
      session.cancellationRequested ? "manual-cancel" : "exit",
    ),
  );
  if (!adopted) {
    return undefined;
  }
  // The reaper reports an exit no earlier than its next tick, after this registration.
  const session = registerProcessSession({
    id: createProcessSessionId(),
    command: survivor.command ?? `pid ${survivor.pid}`,
    scopeKey: parent.scopeKey,
    sessionKey: parent.sessionKey,
    agentId: parent.agentId,
    cleanupMs: parent.cleanupMs,
    notifyOnExit: false,
    notifyOnExitEmptySuccess: false,
    exitNotified: false,
    startedAt: Date.now(),
    cwd: parent.cwd,
    maxOutputChars: parent.maxOutputChars,
    pendingMaxOutputChars: parent.pendingMaxOutputChars,
    totalOutputChars: 0,
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    pendingOutputDropped: false,
    exited: false,
    truncated: false,
    backgrounded: true,
    cursorKeyMode: "normal",
    pid: survivor.pid,
    processActivity: { resultSettled: false, lastOutputAtMs: Date.now() },
    adopted: {
      stop: async (options) => {
        const outcome = await adopted.stop(options);
        session.cleanupUncertain = outcome.status === "uncertain";
        if (outcome.status === "uncertain") {
          appendOutput(
            session,
            "stderr",
            `\nOpenClaw could not confirm that pid ${survivor.pid} stopped: ${outcome.reason}. It may still be running.\n`,
          );
        }
        return outcome;
      },
    },
  });
  return session;
}

/**
 * Adopt every process a completed command left running as a tracked background
 * session of its session. Capacity belongs to declared services only
 * (`reserveServiceSlot`): a survivor neither counts nor is stopped for capacity,
 * so nothing escapes custody and no helper is killed. Returns the lines for the tool result.
 */
export function adoptExecSurvivors(
  parent: ProcessSession,
  survivors: readonly ReleasedProcess[],
): string[] {
  return survivors.flatMap((survivor) => {
    const session = adoptSurvivor(parent, survivor);
    return session
      ? [
          `${formatProcess(survivor)} keeps running as background session ${session.id}: process list shows it and process kill ${session.id} stops it. Its later output to this command's stdout/stderr is discarded; redirect it to a file to keep it.`,
        ]
      : [];
  });
}
