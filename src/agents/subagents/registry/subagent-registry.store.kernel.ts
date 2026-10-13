import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../../infra/kysely-sync.js";
import { parseSqliteTableDefinition } from "../../../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../../../infra/sqlite-schema-facts.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import { ensureColumn } from "../../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { subagentRunRowVersion, type SubagentRunSqliteRow } from "./subagent-registry.store.row.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.types.js";
import { isSubagentRunGenerationCandidate } from "./subagent-run-generation.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;
// Eight bound columns per row keep each statement within 1,024 parameters.
const MAX_SUBAGENT_UPSERT_ROWS = 128;

/** Check every admitted row before any row or companion effect is changed. */
export function conflictingSubagentRunVersions(
  database: OpenClawStateDatabase,
  versions: SubagentRegistryWrite["versions"],
): string[] {
  if (versions.length === 0) {
    return [];
  }
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("subagent_runs")
      .selectAll()
      .where("run_id", "in", sqliteStringSet(versions.map(({ runId }) => runId))),
  ).rows;
  const current = new Map(rows.map((row) => [row.run_id, subagentRunRowVersion(row)]));
  return versions.flatMap(({ runId, version }) =>
    (current.get(toUSVString(runId)) ?? null) === version ? [] : [runId],
  );
}

export function conflictingSubagentRegistrationCohort(
  database: OpenClawStateDatabase,
  cohort: SubagentRegistryWrite["registrationCohort"],
): string[] {
  if (!cohort) {
    return [];
  }
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(database.db);
  const actual = new Set(
    executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("subagent_runs")
        .selectAll()
        .where("child_session_key", "=", toUSVString(cohort.childSessionKey)),
    ).rows.flatMap((row) => {
      const entry = rowToSubagentRunRecord(row);
      return !entry ||
        isSubagentRunGenerationCandidate(entry, cohort.childSessionKey, cohort.childAgentId)
        ? [row.run_id]
        : [];
    }),
  );
  const expected = new Set(cohort.runIds.map(toUSVString));
  return [
    ...[...actual].filter((runId) => !expected.has(runId)),
    ...[...expected].filter((runId) => !actual.has(runId)),
  ];
}

const parentStoreSchemas = new WeakMap<SqliteSchemaFacts, boolean>();

export function hasParentStoreColumns(db: DatabaseSync): boolean {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Subagent rows require admitted schema facts");
  }
  let present = parentStoreSchemas.get(schema);
  if (present === undefined) {
    const table = schema.tableSql.get("subagent_runs");
    const columns = table ? parseSqliteTableDefinition(table, "subagent_runs").columns : undefined;
    present = Boolean(columns?.has("requester_store_path") && columns.has("controller_store_path"));
    parentStoreSchemas.set(schema, present);
  }
  return present;
}

/** Applies selected row changes inside the caller's transaction. */
export function writeSubagentRunValuesInDatabase(
  database: OpenClawStateDatabase,
  values: readonly SubagentRunSqliteRow[],
  deleteRunIds: readonly string[],
): void {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  if (values.length > 0 && !hasParentStoreColumns(db)) {
    ensureColumn(db, "subagent_runs", "requester_store_path TEXT");
    ensureColumn(db, "subagent_runs", "controller_store_path TEXT");
  }
  for (let offset = 0; offset < values.length; offset += MAX_SUBAGENT_UPSERT_ROWS) {
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("subagent_runs")
        .values(values.slice(offset, offset + MAX_SUBAGENT_UPSERT_ROWS))
        .onConflict((conflict) =>
          conflict.column("run_id").doUpdateSet((eb) => ({
            child_session_key: eb.ref("excluded.child_session_key"),
            controller_session_key: eb.ref("excluded.controller_session_key"),
            requester_session_key: eb.ref("excluded.requester_session_key"),
            requester_store_path: eb.ref("excluded.requester_store_path"),
            controller_store_path: eb.ref("excluded.controller_store_path"),
            created_at: eb.ref("excluded.created_at"),
            payload_json: eb.ref("excluded.payload_json"),
          })),
        ),
    );
  }
  if (deleteRunIds.length > 0) {
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("subagent_runs").where("run_id", "in", deleteRunIds),
    );
  }
}
