/**
 * Owns host access and persistence for the shared SQLite subagent registry.
 */
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../../state/openclaw-state-db.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import {
  writeSubagentRunValuesInDatabase,
  type BoundSubagentRunRecord,
} from "./subagent-registry.store.kernel.js";
import {
  loadSubagentMaintenanceRunsInDatabase,
  loadSubagentRegistryInDatabase,
  loadSubagentRunsForSessionsInDatabase,
  loadSubagentRunsInDatabase,
} from "./subagent-registry.store.read.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";

function writeSubagentRunValues(
  values: readonly BoundSubagentRunRecord[],
  deleteRunIds?: readonly string[],
  retainedRunIds?: readonly string[],
): void {
  if (values.length === 0 && deleteRunIds?.length === 0 && retainedRunIds === undefined) {
    return;
  }
  runOpenClawStateWriteTransaction((database) =>
    writeSubagentRunValuesInDatabase(database, values, deleteRunIds, retainedRunIds),
  );
}

/** Loads runs controlled by one session, preserving the legacy requester fallback. */
export function loadSubagentRunsForControllerFromSqlite(
  controllerSessionKey: string,
): SubagentRunRecord[] {
  const sessionKey = controllerSessionKey.trim();
  return sessionKey
    ? loadSubagentRunsInDatabase(openOpenClawStateDatabase(), { kind: "controller", sessionKey })
    : [];
}

/** Loads all persisted generations for one child session through its existing index. */
export function loadSubagentRunsForChildSessionFromSqlite(
  childSessionKey: string,
): SubagentRunRecord[] {
  const sessionKey = childSessionKey.trim();
  return sessionKey
    ? loadSubagentRunsInDatabase(openOpenClawStateDatabase(), { kind: "child", sessionKey })
    : [];
}

export function loadSubagentRegistryFromSqlite(): Map<string, SubagentRunRecord> {
  return loadSubagentRegistryInDatabase(openOpenClawStateDatabase());
}

export function loadSubagentMaintenanceRunsFromSqlite(): Map<string, SubagentRunMaintenanceRecord> {
  return loadSubagentMaintenanceRunsInDatabase(openOpenClawStateDatabase());
}

export function loadSubagentRunsForSessionsFromSqlite(
  sessionKeys: readonly string[],
  inMemoryRuns: Iterable<SubagentRunReadRecord>,
  projection: "full",
): { sessionKeys: Set<string>; runs: Map<string, SubagentRunRecord>; complete: boolean };
export function loadSubagentRunsForSessionsFromSqlite(
  sessionKeys: readonly string[],
  inMemoryRuns: Iterable<SubagentRunReadRecord>,
  projection: "session-list",
): { sessionKeys: Set<string>; runs: Map<string, SubagentRunReadRecord>; complete: boolean };
export function loadSubagentRunsForSessionsFromSqlite(
  sessionKeys: readonly string[],
  inMemoryRuns: Iterable<SubagentRunReadRecord>,
  projection: "full" | "session-list",
): { sessionKeys: Set<string>; runs: Map<string, SubagentRunReadRecord>; complete: boolean } {
  return loadSubagentRunsForSessionsInDatabase(
    openOpenClawStateDatabase(),
    sessionKeys,
    inMemoryRuns,
    projection,
  );
}

/** Saves the complete subagent run snapshot to sqlite and prunes rows not in the snapshot. */
export function saveSubagentRegistryToSqlite(runs: Map<string, SubagentRunRecord>): void {
  const values = [...runs.values()].map(bindSubagentRunRecord);
  writeSubagentRunValues(
    values,
    undefined,
    values.map((row) => row.run_id),
  );
}

/** Persists only named run mutations, deleting names absent from the current registry. */
export function saveSubagentRegistryChangesToSqlite(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
): void {
  const runIds = [...new Set(changedRunIds.map((runId) => runId.trim()).filter(Boolean))];
  const values: BoundSubagentRunRecord[] = [];
  const deleteRunIds: string[] = [];
  for (const runId of runIds) {
    const entry = runs.get(runId);
    if (entry) {
      values.push(bindSubagentRunRecord(entry));
    } else {
      deleteRunIds.push(runId);
    }
  }
  writeSubagentRunValues(values, deleteRunIds);
}
