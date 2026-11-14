import {
  adoptReleasedProcess,
  killReleasedProcess,
} from "../process/supervisor/released-processes.js";
import type { ReleasedProcess } from "../process/supervisor/types.js";
import { createProcessSessionId } from "./bash-process-id.js";
import {
  addSession,
  createProcessSession,
  listRunningSessions,
  markExited,
  type ProcessSession,
} from "./bash-process-registry.js";

/** Services are admitted, never evicted: background sessions plus adopted survivors. */
export const MAX_SERVICES_PER_SESSION = 16;
export const MAX_SERVICES_PER_GATEWAY = 64;

/** Explain the limit when a new service would cross it; undefined when there is room. */
export function serviceCapacityError(scopeKey: string | undefined): string | undefined {
  const running = listRunningSessions().filter((session) => !session.exited);
  const inSession = running.filter((session) => session.scopeKey === scopeKey).length;
  if (inSession < MAX_SERVICES_PER_SESSION && running.length < MAX_SERVICES_PER_GATEWAY) {
    return undefined;
  }
  return `This session runs ${inSession} of ${MAX_SERVICES_PER_SESSION} allowed services (Gateway: ${running.length} of ${MAX_SERVICES_PER_GATEWAY}). Use process list to see them and process kill <sessionId> to stop ones you no longer need.`;
}

function formatProcess({ pid, command }: ReleasedProcess): string {
  return command ? `pid ${pid} (${command})` : `pid ${pid}`;
}

/**
 * Turn processes a completed command left running into tracked background sessions.
 * Over the service limit, stop the new ones by identity instead. Returns result lines.
 */
export async function adoptExecSurvivors(
  parent: ProcessSession,
  survivors: readonly ReleasedProcess[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const survivor of survivors) {
    const capacityError = serviceCapacityError(parent.scopeKey);
    if (capacityError) {
      await killReleasedProcess(survivor);
      lines.push(
        `Stopped ${formatProcess(survivor)}, which the command left running: ${capacityError}`,
      );
      continue;
    }
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
      continue;
    }
    session.adopted = adopted;
    addSession(session);
    lines.push(
      `${formatProcess(survivor)} keeps running as background session ${session.id}: process list shows it and process kill ${session.id} stops it. Its later output to this command's stdout/stderr is discarded; redirect it to a file to keep it.`,
    );
  }
  return lines;
}
