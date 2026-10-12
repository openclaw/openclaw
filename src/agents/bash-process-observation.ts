import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  SESSION_PROCESS_NAME_MAX_CHARS,
  SESSION_PROCESS_TAIL_MAX_CHARS,
  SESSION_PROCESSES_MAX_BYTES,
  SESSION_PROCESSES_MAX_ROWS,
  type SessionProcessSummary,
} from "../../packages/gateway-protocol/src/schema/session-processes.js";
import {
  cancelBackgroundExecSession,
  isBackgroundExecCancellable,
  isConfirmedRequestedStop,
} from "./bash-process-control.js";
import {
  compareProcessSessionStartOrder,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  processSessionInstanceId,
  tail,
  type ProcessSession,
} from "./bash-process-registry.js";
import { deriveSessionName } from "./bash-tools.shared.js";

export type ProcessObservationScope = { scopeKeys: readonly string[]; agentId: string };

function inScope(session: ProcessSession, scope: ProcessObservationScope): boolean {
  return Boolean(
    session.scopeKey &&
    scope.scopeKeys.includes(session.scopeKey) &&
    (session.agentId === undefined || session.agentId === scope.agentId) &&
    (session.scopeKey !== "global" || session.agentId === scope.agentId),
  );
}

/** Non-consuming observation: never drains poll output or acknowledges an exit notification. */
export function readBackgroundProcesses(scope: ProcessObservationScope): {
  processes: SessionProcessSummary[];
  truncated: boolean;
} {
  const sessions = [...listRunningSessions(), ...listFinishedSessions()]
    .filter((session) => inScope(session, scope))
    .toSorted(
      (a, b) => Number(a.exited) - Number(b.exited) || compareProcessSessionStartOrder(a, b),
    );
  const processes: SessionProcessSummary[] = [];
  let bytes = 0;
  for (const session of sessions) {
    const output = tail(session.tail, SESSION_PROCESS_TAIL_MAX_CHARS);
    const row: SessionProcessSummary = {
      processId: session.id,
      instanceId: processSessionInstanceId(session),
      name: truncateUtf16Safe(
        deriveSessionName(session.command) || session.command,
        SESSION_PROCESS_NAME_MAX_CHARS,
      ),
      status: isConfirmedRequestedStop(session) ? "killed" : (session.terminalStatus ?? "running"),
      startedAt: session.startedAt,
      ...(session.endedAt !== undefined ? { endedAt: session.endedAt } : {}),
      tail: output,
      truncated: session.truncated || session.totalOutputChars > output.length,
      canStop: isBackgroundExecCancellable(session) && !session.cancellationRequested,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.exitSignal !== undefined ? { exitSignal: session.exitSignal } : {}),
      ...(session.exitReason !== undefined ? { exitReason: session.exitReason } : {}),
    };
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8");
    if (processes.length >= SESSION_PROCESSES_MAX_ROWS || bytes > SESSION_PROCESSES_MAX_BYTES) {
      break;
    }
    processes.push(row);
  }
  return { processes, truncated: processes.length < sessions.length };
}

/** The session authority is checked by the caller; this owner checks the exact process object. */
export function stopBackgroundProcess(
  scope: ProcessObservationScope,
  target: { processId: string; instanceId: string },
): { requested: boolean } {
  const session = getSession(target.processId);
  return {
    requested: Boolean(
      session &&
      inScope(session, scope) &&
      processSessionInstanceId(session) === target.instanceId &&
      cancelBackgroundExecSession(session.id),
    ),
  };
}
