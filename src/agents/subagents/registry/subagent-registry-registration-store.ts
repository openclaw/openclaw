import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { readTaskBackingInstance } from "../../../tasks/task-backing-authority.js";
import {
  publishPreparedTaskRecordCreation,
  type PreparedTaskRecordCreation,
} from "../../../tasks/task-registry-record-api.js";
import {
  bindTaskDeliveryState,
  bindTaskRecord,
  hasTaskRunIdentityClaimInDatabase,
  upsertTaskDeliveryStateRowInDatabase,
  upsertTaskRunRowInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import {
  bindSubagentRunRecord,
  findSubagentRunIdentityClaimInDatabase,
  upsertSubagentRunRowInDatabase,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentRegistrationRollback(params: {
  runs: Map<string, SubagentRunRecord>;
  runId: string;
  entry: SubagentRunRecord;
  previousRunOwner: SubagentRunRecord | undefined;
  isCurrent: () => boolean;
  restorePredecessors: () => void;
  restoreRegisteredPredecessors: () => void;
}) {
  let ownedBeforeRollback = false;
  return {
    rollback(): void {
      ownedBeforeRollback = params.runs.get(params.runId) === params.entry && params.isCurrent();
      if (params.runs.get(params.runId) === params.entry) {
        if (params.previousRunOwner) {
          params.runs.set(params.runId, params.previousRunOwner);
        } else {
          params.runs.delete(params.runId);
        }
      }
      if (ownedBeforeRollback) {
        params.restorePredecessors();
      }
    },
    restoreDurable(): boolean {
      if (!ownedBeforeRollback || params.runs.has(params.runId)) {
        return false;
      }
      params.runs.set(params.runId, params.entry);
      if (!params.isCurrent()) {
        params.runs.delete(params.runId);
        return false;
      }
      params.restoreRegisteredPredecessors();
      return true;
    },
  };
}

export function createSubagentRegistrationRollbackError(
  error: unknown,
  rollbackError: unknown,
): AggregateError {
  return new AggregateError(
    [error, rollbackError],
    `Custom task registration failed: ${String(error)}; registry rollback also failed: ${String(rollbackError)}`,
    { cause: error },
  );
}

export function findSubagentRunByIdentity(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  runId: string,
): SubagentRunRecord | undefined {
  return runs.get(runId) ?? [...runs.values()].find((candidate) => candidate.swarmRunId === runId);
}

export function assertSubagentRegistrationIdentityAvailable(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  runId: string,
  findPersistedIdentityClaim: (runId: string) => SubagentRunRecord | null,
): void {
  const claim =
    [...runs.values()].find(
      (candidate) =>
        candidate.runId === runId ||
        candidate.taskRunId?.trim() === runId ||
        candidate.swarmRunId?.trim() === runId,
    ) ?? findPersistedIdentityClaim(runId);
  if (claim) {
    throw new Error(
      `Subagent run identity ${runId} is already owned. Inspect the existing run before retrying the spawn request.`,
    );
  }
}

function assertRegistrationCorrelation(
  entry: SubagentRunRecord,
  prepared: Extract<PreparedTaskRecordCreation, { kind: "create" }>,
): void {
  const task = prepared.record;
  const backing = readTaskBackingInstance(task.detail);
  if (
    backing?.runtime !== "subagent" ||
    backing.generation !== entry.generation ||
    task.runtime !== "subagent" ||
    task.runId !== (entry.taskRunId ?? entry.runId) ||
    task.ownerKey !== entry.requesterSessionKey ||
    task.childSessionKey !== entry.childSessionKey ||
    (task.status !== "queued" && task.status !== "running")
  ) {
    throw new Error("subagent registration and task do not share one owner generation");
  }
}

/** Commits required registry and task ownership, then releases their process-local observers. */
export function commitSubagentTaskRegistration(params: {
  runs: Map<string, SubagentRunRecord>;
  changedRunIds: readonly string[];
  entry: SubagentRunRecord;
  task: Extract<PreparedTaskRecordCreation, { kind: "create" }>;
  isCurrent: (task: TaskRecord) => boolean;
}): { task: TaskRecord; retainedOwnership: boolean } {
  assertRegistrationCorrelation(params.entry, params.task);
  const runRows = params.changedRunIds.flatMap((runId) => {
    const entry = params.runs.get(runId);
    return entry ? [bindSubagentRunRecord(entry)] : [];
  });
  const taskRow = bindTaskRecord(params.task.record);
  const deliveryRow = params.task.deliveryState
    ? bindTaskDeliveryState(params.task.deliveryState)
    : undefined;

  runOpenClawStateWriteTransaction(
    (database) => {
      if (findSubagentRunIdentityClaimInDatabase(database, params.entry.runId)) {
        throw new Error(
          `Subagent run identity ${params.entry.runId} is already owned. Inspect the existing run before retrying the spawn request.`,
        );
      }
      if (taskRow.run_id && hasTaskRunIdentityClaimInDatabase(database, taskRow.run_id)) {
        throw new Error(
          `Subagent task run identity ${taskRow.run_id} is already owned. Inspect the existing task before retrying the spawn request.`,
        );
      }
      for (const row of runRows) {
        upsertSubagentRunRowInDatabase(database, row);
      }
      upsertTaskRunRowInDatabase(database, taskRow);
      if (deliveryRow) {
        upsertTaskDeliveryStateRowInDatabase(database.db, deliveryRow);
      }
    },
    undefined,
    { operationLabel: "subagent task registration" },
  );

  // Observer callbacks can synchronously reenter cancellation and wait paths.
  // Publish ownership and both caches before releasing either callback.
  subagentRuns.commitOwnership(params.entry);
  const deferredObserverEvents: Array<() => void> = [];
  publishSubagentRunsAfterAtomicStore(params.runs, params.changedRunIds, deferredObserverEvents, {
    isCurrent: () => params.isCurrent(params.task.record),
  });
  const task = publishPreparedTaskRecordCreation(params.task, deferredObserverEvents);
  for (const emitObserverEvent of deferredObserverEvents) {
    if (!params.isCurrent(params.task.record)) {
      return { task, retainedOwnership: false };
    }
    emitObserverEvent();
  }
  return { task, retainedOwnership: params.isCurrent(params.task.record) };
}
