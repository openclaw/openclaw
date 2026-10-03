import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "./subagent-registry.store.kernel.js";
import type { SubagentRunSqliteRow } from "./subagent-registry.store.row.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

function writeSubagentRunValues(
  values: readonly SubagentRunSqliteRow[],
  deleteRunIds?: readonly string[],
  retainedRunIds?: readonly string[],
): void {
  if (values.length === 0 && deleteRunIds?.length === 0 && retainedRunIds === undefined) {
    return;
  }
  runOpenClawStateWriteTransaction((database) => {
    writeSubagentRunValuesInDatabase(
      database,
      values,
      retainedRunIds === undefined ? (deleteRunIds ?? []) : [],
    );
    if (retainedRunIds !== undefined) {
      const stateDb = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "subagent_runs">>(
        database.db,
      );
      const deleteQuery =
        retainedRunIds.length === 0
          ? stateDb.deleteFrom("subagent_runs")
          : stateDb.deleteFrom("subagent_runs").where("run_id", "not in", retainedRunIds);
      executeSqliteQuerySync(database.db, deleteQuery);
    }
  });
}

/** Seed an out-of-band snapshot without publishing resident facts. */
export function saveSubagentRegistryToSqlite(runs: Map<string, SubagentRunRecord>): void {
  const values = [...runs.values()].map(bindSubagentRunRecord);
  writeSubagentRunValues(
    values,
    undefined,
    values.map((row) => row.run_id),
  );
}

/** Seed named foreign writes, deleting IDs absent from the supplied fixture. */
export function saveSubagentRegistryChangesToSqlite(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
): void {
  const runIds = [...new Set(changedRunIds.map((runId) => runId.trim()).filter(Boolean))];
  const values: SubagentRunSqliteRow[] = [];
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

/** Seed committed projection facts; row-owner behavior is exercised by the real-worker tests. */
export function persistRegistryFixture(
  runs: Map<string, SubagentRunRecord>,
  runIds?: readonly string[],
): void {
  if (runIds) {
    saveSubagentRegistryChangesToSqlite(runs, runIds);
  } else {
    saveSubagentRegistryToSqlite(runs);
  }
  const events: Array<() => void> = [];
  const published = new Map(runs);
  for (const id of runIds ?? runs.keys()) {
    const entry = runs.get(id);
    if (entry) {
      published.set(id, copySubagentRunRuntimeOwner(entry, structuredClone(entry)));
    }
  }
  publishSubagentRunsAfterAtomicStore(published, runIds, events);
  events.forEach((publish) => publish());
}
