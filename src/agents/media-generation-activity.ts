import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Process-owned provider work. Completion delivery belongs to the durable session queue. */
export type MediaGenerationOperation = {
  taskId: string;
  runId?: string;
  taskKind: string;
  sourceId?: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  task?: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: "blocked";
  error?: string;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.mediaGenerationOperations"), () => ({
  operations: new Map<string, MediaGenerationOperation>(),
  active: new Map<string, { sessionKey: string; agentId?: string; generation: string }>(),
  owners: new Map<string, string>(),
  admissions: new Map<string, string>(),
}));
const RECENT_COMPLETION_MS = 2 * 60_000;

function pruneCompletedOperations(): void {
  const now = Date.now();
  const cutoff = now - RECENT_COMPLETION_MS;
  const generation = getAgentRunLifecycleGeneration();
  for (const [id, operation] of state.operations) {
    if (
      state.owners.get(id) !== generation ||
      (operation.endedAt !== undefined &&
        operation.endedAt <
          (operation.terminalOutcome === "blocked" ? now - 7 * 24 * 60 * 60_000 : cutoff))
    ) {
      state.operations.delete(id);
      state.active.delete(id);
      state.owners.delete(id);
    }
  }
}

export function registerGeneratedMediaTaskActivity(
  runId: string,
  sessionKey: string,
  requesterAgentId?: string,
): void {
  if (!runId || !sessionKey) {
    return;
  }
  const generation = getAgentRunLifecycleGeneration();
  const owner = state.owners.get(runId);
  if (owner && owner !== generation) {
    return;
  }
  state.owners.set(runId, generation);
  const agentId = requesterAgentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  const admissionKey = `${generation}\0${agentId ?? ""}\0${sessionKey}`;
  if (!state.active.has(runId)) {
    state.admissions.delete(admissionKey);
    state.admissions.set(admissionKey, runId);
    pruneMapToMaxSize(state.admissions, 2_048);
  }
  state.active.set(runId, {
    sessionKey,
    agentId: requesterAgentId ?? parseAgentSessionKey(sessionKey)?.agentId,
    generation,
  });
}
export function clearGeneratedMediaTaskActivity(runId: string): void {
  state.active.delete(runId);
}
export function createMediaGenerationOperation(
  operation: MediaGenerationOperation,
): MediaGenerationOperation {
  pruneCompletedOperations();
  if (!operation.runId || state.operations.has(operation.runId)) {
    throw new Error("Media operation identity already admitted");
  }
  state.operations.set(operation.runId, operation);
  registerGeneratedMediaTaskActivity(
    operation.runId,
    operation.requesterSessionKey,
    operation.requesterAgentId,
  );
  return operation;
}
export function updateMediaGenerationOperation(
  runId: string,
  update: Partial<
    Pick<
      MediaGenerationOperation,
      | "status"
      | "endedAt"
      | "lastEventAt"
      | "progressSummary"
      | "terminalSummary"
      | "terminalOutcome"
      | "error"
    >
  >,
): void {
  const operation = state.operations.get(runId);
  if (!operation || !isMediaGenerationOperationCurrent(runId) || operation.endedAt !== undefined) {
    return;
  }
  Object.assign(operation, update);
}
export function findMediaGenerationOperation(runId: string): MediaGenerationOperation | undefined {
  return isMediaGenerationOperationCurrent(runId) ? state.operations.get(runId) : undefined;
}
export function listMediaGenerationOperations(
  sessionKey: string,
  requesterAgentId?: string,
): MediaGenerationOperation[] {
  pruneCompletedOperations();
  const agentId = requesterAgentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId) {
    return [];
  }
  return [...state.operations.values()].filter(
    (operation) =>
      operation.requesterSessionKey === sessionKey &&
      (operation.requesterAgentId ??
        parseAgentSessionKey(operation.requesterSessionKey)?.agentId) === agentId &&
      Boolean(operation.runId && isMediaGenerationOperationCurrent(operation.runId)),
  );
}
export function isTerminalMediaGenerationStatus(
  status: MediaGenerationOperation["status"],
): boolean {
  return status === "succeeded" || status === "failed";
}
export function getGeneratedMediaTaskIdsForSessionKey(
  sessionKey: string | undefined,
  requesterAgentId?: string,
): ReadonlySet<string> {
  if (!sessionKey) {
    return new Set();
  }
  const agentId = requesterAgentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId) {
    return new Set();
  }
  const latest = state.admissions.get(
    `${getAgentRunLifecycleGeneration()}\0${agentId}\0${sessionKey}`,
  );
  return new Set([
    ...listMediaGenerationOperations(sessionKey, agentId).map((operation) => operation.taskId),
    ...(latest ? ["run:" + latest] : []),
  ]);
}
export function hasNewGeneratedMediaTaskForSessionKey(
  sessionKey: string | undefined,
  before: ReadonlySet<string>,
  requesterAgentId?: string,
): boolean {
  return [...getGeneratedMediaTaskIdsForSessionKey(sessionKey, requesterAgentId)].some(
    (id) => !before.has(id),
  );
}
export function hasPendingGeneratedMediaTaskForSessionKey(
  sessionKey: string,
  requesterAgentId?: string,
): boolean {
  const agentId = requesterAgentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId) {
    return false;
  }
  return [...state.active.values()].some(
    (activity) =>
      activity.sessionKey === sessionKey &&
      activity.agentId === agentId &&
      activity.generation === getAgentRunLifecycleGeneration(),
  );
}
export function buildPendingGeneratedMediaSessionKeySet(): Set<string> {
  return new Set(
    [...state.active.values()]
      .filter((activity) => activity.generation === getAgentRunLifecycleGeneration())
      .map((activity) => activity.sessionKey),
  );
}
export function getActiveMediaGenerationRunCount(): number {
  pruneCompletedOperations();
  return [...state.active.values()].filter(
    (activity) => activity.generation === getAgentRunLifecycleGeneration(),
  ).length;
}

export function isMediaGenerationOperationCurrent(runId: string): boolean {
  return state.owners.get(runId) === getAgentRunLifecycleGeneration();
}
