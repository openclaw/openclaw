import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { isPostgresSqlConnection } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { VECTOR_UNIT_NORM_META_KEY } from "./memory/manager-vector-unit-norm.js";

/** The writer advances the revision once, inside the transaction that changes the index. */
export function advanceMemoryIndexRevision(db: EngineConnection): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<{ memory_index_state: { id: number; revision: number } }>(db)
      .updateTable("memory_index_state")
      .set((eb) => ({ revision: eb("revision", "+", 1) }))
      .where("id", "=", 1),
  );
  if (!isPostgresSqlConnection(db)) {
    // This release keeps stored SQLite vectors unit length: a current marker stays current.
    db.prepare(
      `UPDATE memory_index_meta
       SET value = CAST((SELECT revision FROM memory_index_state WHERE id = 1) AS TEXT)
       WHERE key = ? AND value = CAST((SELECT revision - 1 FROM memory_index_state WHERE id = 1) AS TEXT)`,
    ).run(VECTOR_UNIT_NORM_META_KEY);
  }
}
