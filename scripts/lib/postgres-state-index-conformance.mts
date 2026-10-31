import assert from "node:assert/strict";
import type { Client } from "pg";
import {
  assertPostgresCatalog,
  postgresCatalogQuery,
  readPostgresCatalog,
} from "../../src/infra/database-engine/postgres-catalog.ts";
import { TASK_RUN_INDEX_REPLACEMENTS_V24 } from "../../src/state/openclaw-state-db-schema-v24-indexes.ts";
import { quote } from "./postgres-schema-catalog.mts";

// Historical v22 definitions, independent of the migration's retired-index inventory.
const historicalTaskIndexes = [
  ["idx_task_runs_run_id", "run_id"],
  ["idx_task_runs_status", "status"],
  ["idx_task_runs_runtime_status", "runtime, status"],
  ["idx_task_runs_cleanup_after", "cleanup_after"],
  ["idx_task_runs_last_event_at", "last_event_at"],
  ["idx_task_runs_owner_key", "owner_key"],
  ["idx_task_runs_parent_flow_id", "parent_flow_id"],
  ["idx_task_runs_child_session_key", "child_session_key"],
  ["idx_task_runs_requester_session_key", "requester_session_key"],
  ["idx_task_runs_runtime_source_ended", "runtime, source_id, ended_at, created_at, task_id"],
  ["idx_task_runs_runtime_ended", "runtime, ended_at, created_at, task_id"],
] as const;

/** Forward-DDL readiness only; shared-state PostgreSQL runtime admission remains disabled. */
export async function checkStateTaskIndexMigration(
  client: Client,
  namespace: string,
  forwardSql: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path = ${quote(namespace)}`);
    await client.query(
      `INSERT INTO task_runs
        (task_id, runtime, owner_key, scope_kind, task, status, delivery_status,
         notify_policy, created_at, source_id, run_id, label, detail_json)
       VALUES ('v24-retained', 'cron', 'synthetic-owner', 'system', 'synthetic task',
         'succeeded', 'not_applicable', 'silent', 100, 'synthetic-job', 'synthetic-run',
         'synthetic label', $1)`,
      [JSON.stringify({ synthetic: true, body: "x".repeat(32 * 1024) })],
    );
    await client.query("CREATE INDEX idx_task_runs_conformance_local ON task_runs(label)");
    const retained = (await client.query("SELECT * FROM task_runs ORDER BY task_id")).rows;
    const catalogSql = postgresCatalogQuery(namespace, true);
    // Compare the historical v24 destination, not later index-ordering migrations.
    for (const name of TASK_RUN_INDEX_REPLACEMENTS_V24) {
      await client.query(`DROP INDEX ${quote(name)}`);
    }
    await client.query(forwardSql);
    const fresh = readPostgresCatalog((await client.query(catalogSql)).rows[0].catalog);

    for (const name of TASK_RUN_INDEX_REPLACEMENTS_V24) {
      await client.query(`DROP INDEX ${quote(name)}`);
    }
    for (const [name, columns] of historicalTaskIndexes) {
      const keys = columns.split(", ").map((column) => `(${quote(column)}) ASC NULLS FIRST`);
      await client.query(`CREATE INDEX ${quote(name)} ON task_runs(${keys.join(", ")})`);
    }
    await client.query(forwardSql);

    assert.deepEqual(
      (await client.query("SELECT * FROM task_runs ORDER BY task_id")).rows,
      retained,
      "Task index migration changed retained task rows or payloads",
    );
    // Include definitions: counts alone miss changed key order, predicates, or NULL ordering.
    assertPostgresCatalog(
      readPostgresCatalog((await client.query(catalogSql)).rows[0].catalog),
      fresh,
    );
  } finally {
    await client.query("ROLLBACK");
  }
}
