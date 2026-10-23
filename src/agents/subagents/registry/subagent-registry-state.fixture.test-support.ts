import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import { bindSubagentRunRecord, rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

export function createSubagentStoreRunFixture(
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  const timing = { startedAt: 110, endedAt: 250 };
  const identity = {
    childSessionKey: "agent:main:subagent:one",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "check sqlite persistence",
  };
  return {
    runId: "run-one",
    ...identity,
    cleanup: "keep",
    createdAt: 100,
    expectsCompletionMessage: true,
    execution: {
      status: "terminal",
      ...timing,
      outcome: { status: "ok", ...timing, elapsedMs: 140 },
    },
    completion: {
      required: true,
      resultText: "done",
      capturedAt: 260,
      terminalReply: { disposition: "visible", text: "done" },
    },
    delivery: {
      status: "pending",
      createdAt: 270,
      lastAttemptAt: 280,
      attemptCount: 2,
      lastError: "retry later",
      payload: {
        ...identity,
        childRunId: "run-one",
        ...timing,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
      },
    },
    ...overrides,
  };
}

/** Inspect fixture storage independently of resident projections and worker transport. */
export function loadSubagentRegistryFromSqlite(
  database: Pick<OpenClawStateDatabase, "db"> = openOpenClawStateDatabase(),
): Map<string, SubagentRunRecord> {
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "subagent_runs">>(database.db)
      .selectFrom("subagent_runs")
      .selectAll()
      .orderBy("created_at", "asc")
      .orderBy("run_id", "asc"),
  ).rows;
  return new Map(
    rows.flatMap((row) => {
      const entry = rowToSubagentRunRecord(row);
      return entry ? [[entry.runId, entry] as const] : [];
    }),
  );
}

function writeFixture(runs: Map<string, SubagentRunRecord>, changedRunIds?: readonly string[]) {
  const ids = changedRunIds
    ? [...new Set(changedRunIds.map((id) => id.trim()).filter(Boolean))]
    : [...runs.keys()];
  if (changedRunIds && ids.length === 0) {
    return;
  }
  const values = ids.flatMap((id) => {
    const entry = runs.get(id);
    return entry ? [bindSubagentRunRecord(entry)] : [];
  });
  runOpenClawStateWriteTransaction((database) => {
    writeSubagentRunValuesInDatabase(
      database,
      values,
      changedRunIds ? ids.filter((id) => !runs.has(id)) : [],
    );
    if (!changedRunIds) {
      const stateDb = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "subagent_runs">>(
        database.db,
      );
      let deleteQuery = stateDb.deleteFrom("subagent_runs");
      if (values.length) {
        deleteQuery = deleteQuery.where(
          "run_id",
          "not in",
          values.map((row) => row.run_id),
        );
      }
      executeSqliteQuerySync(database.db, deleteQuery);
    }
  });
}

/** Seed an out-of-band snapshot without publishing resident facts. */
export function saveSubagentRegistryToSqlite(runs: Map<string, SubagentRunRecord>): void {
  writeFixture(runs);
}

/** Seed named foreign writes, deleting IDs absent from the supplied fixture. */
export function saveSubagentRegistryChangesToSqlite(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
): void {
  writeFixture(runs, changedRunIds);
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
  publishRegistryFixture(runs, runIds);
}

function publishRegistryFixture(
  runs: Map<string, SubagentRunRecord>,
  runIds?: readonly string[],
): void {
  const published = new Map(runs);
  for (const id of runIds ?? runs.keys()) {
    const entry = runs.get(id);
    if (entry) {
      published.set(id, copySubagentRunRuntimeOwner(entry, structuredClone(entry)));
    }
  }
  publishSubagentRunsAfterAtomicStore(published, runIds)();
}
