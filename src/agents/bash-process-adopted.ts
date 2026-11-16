import {
  adoptReleasedProcess,
  killReleasedProcess,
} from "../process/supervisor/released-processes.js";
import type { ReleasedProcess } from "../process/supervisor/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createProcessSessionId } from "./bash-process-id.js";
import {
  addSession,
  appendOutput,
  createProcessSession,
  listRunningSessions,
  markExited,
  type ProcessSession,
} from "./bash-process-registry.js";

/** Services are admitted, never evicted: background sessions plus adopted survivors. */
const MAX_SERVICES_PER_SESSION = 16;
const MAX_SERVICES_PER_GATEWAY = 64;

// Background starts hold a slot from admission until their session is running
// or startup fails, so concurrent starts cannot pass the limit together.
const reservations = resolveGlobalSingleton(
  Symbol.for("openclaw.execServiceReservations"),
  () => new Set<{ scopeKey: string | undefined }>(),
);

/** Explain the limit when a new service would cross it; undefined when there is room. */
function serviceCapacityError(scopeKey: string | undefined): string | undefined {
  const running = listRunningSessions().filter((session) => !session.exited);
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
export function reserveServiceSlot(
  scopeKey: string | undefined,
  isService = true,
): Disposable | undefined {
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

function formatProcessList(survivors: readonly ReleasedProcess[]): string {
  return survivors.map(formatProcess).join(", ");
}

function adoptSurvivor(parent: ProcessSession, survivor: ReleasedProcess) {
  const session = createProcessSession({
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
  });
  const adopted = adoptReleasedProcess(parent.scopeKey ?? "", survivor, () =>
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
  session.adopted = {
    stop: async () => {
      const outcome = await adopted.stop();
      session.cleanupUncertain = outcome.status === "uncertain";
      if (outcome.status === "uncertain") {
        session.cleanupUncertain = true;
        appendOutput(
          session,
          "stderr",
          `\nOpenClaw could not confirm that pid ${survivor.pid} stopped: ${outcome.reason}. It may still be running.\n`,
        );
      }
      return outcome;
    },
  };
  addSession(session);
  return session;
}

/**
 * Account for every process a completed command left running: adopt each as a
 * tracked background session up to the service limit, and stop the rest by
 * identity. A process whose stop is unconfirmed stays tracked, over the limit,
 * so nothing escapes custody. Returns the lines for the tool result.
 */
export async function adoptExecSurvivors(
  parent: ProcessSession,
  survivors: readonly ReleasedProcess[],
): Promise<string[]> {
  const lines: string[] = [];
  const overflow: ReleasedProcess[] = [];
  let capacityError: string | undefined;
  for (const survivor of survivors) {
    capacityError ??= serviceCapacityError(parent.scopeKey);
    if (capacityError) {
      overflow.push(survivor);
      continue;
    }
    const session = adoptSurvivor(parent, survivor);
    if (session) {
      lines.push(
        `${formatProcess(survivor)} keeps running as background session ${session.id}: process list shows it and process kill ${session.id} stops it. Its later output to this command's stdout/stderr is discarded; redirect it to a file to keep it.`,
      );
    }
  }
  if (overflow.length === 0) {
    return lines;
  }
  const outcomes = await Promise.all(overflow.map(killReleasedProcess));
  const stopped = overflow.filter((_, index) => outcomes[index]!.status === "stopped");
  if (stopped.length > 0) {
    lines.push(
      `Stopped ${stopped.length} process${stopped.length === 1 ? "" : "es"} the command left running, over the service limit: ${formatProcessList(stopped)}. ${capacityError}`,
    );
  }
  overflow.forEach((survivor, index) => {
    const outcome = outcomes[index]!;
    if (outcome.status === "stopped") {
      return;
    }
    const session = adoptSurvivor(parent, survivor);
    if (session) {
      session.cleanupUncertain = true;
    }
    lines.push(
      `Could not confirm that ${formatProcess(survivor)} stopped (${outcome.reason}); it may still be running${session ? ` and stays tracked as background session ${session.id}` : ""}.`,
    );
  });
  return lines;
}
