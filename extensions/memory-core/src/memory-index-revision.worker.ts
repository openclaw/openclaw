import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

/** The writer advances the revision once, inside the transaction that changes the index. */
export function advanceMemoryIndexRevision(db: EngineConnection): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<{ memory_index_state: { id: number; revision: number } }>(db)
      .updateTable("memory_index_state")
      .set((eb) => ({ revision: eb("revision", "+", 1) }))
      .where("id", "=", 1),
  );
}
