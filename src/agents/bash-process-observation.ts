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

export type RunningBackgroundProcessFacts = {
  count: number;
  runIds: string[];
};

function readRunningBackgroundProcessFacts(
  sessions: readonly ProcessSession[],
  scope: ProcessObservationScope,
): RunningBackgroundProcessFacts {
  let count = 0;
  const runIds = new Set<string>();
  for (const session of sessions) {
    if (!session.exited && inScope(session, scope)) {
      count++;
      if (session.originRunId) {
        runIds.add(session.originRunId);
      }
    }
  }
  return { count, runIds: [...runIds].toSorted() };
}

/** One synchronous presentation shares a snapshot; recreate after yielding. */
export function prepareRunningBackgroundProcessFacts() {
  const sessionsByScope = new Map<string, ProcessSession[]>();
  for (const session of listRunningSessions()) {
    const { scopeKey, agentId } = session;
    if (session.exited || !scopeKey || (scopeKey === "global" && agentId === undefined)) {
      continue;
    }
    let sessions = sessionsByScope.get(scopeKey);
    if (!sessions) {
      sessionsByScope.set(scopeKey, (sessions = []));
    }
    sessions.push(session);
  }
  return ({ scopeKeys, agentId }: ProcessObservationScope): RunningBackgroundProcessFacts => {
    let count = 0;
    const runIds = new Set<string>();
    for (let i = 0; i < scopeKeys.length; i++) {
      const key = scopeKeys[i]!;
      if (scopeKeys.indexOf(key) !== i) {
        continue;
      }
      for (const session of sessionsByScope.get(key) ?? []) {
        if (
          (session.agentId === undefined || session.agentId === agentId) &&
          (key !== "global" || session.agentId === agentId)
        ) {
          count++;
          if (session.originRunId) {
            runIds.add(session.originRunId);
          }
        }
      }
    }
    return { count, runIds: [...runIds].toSorted() };
  };
}

/** Reads current scoped process facts without consuming output or exit notifications. */
export function readRunningBackgroundProcessFactsForScope(
  scope: ProcessObservationScope,
): RunningBackgroundProcessFacts {
  return readRunningBackgroundProcessFacts(listRunningSessions(), scope);
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
