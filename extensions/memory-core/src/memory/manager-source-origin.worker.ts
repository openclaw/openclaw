import type { DatabaseSync } from "node:sqlite";
import type {
  MemoryEntryProvenance,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

type MemoryOriginClass = MemoryEntryProvenance["originClass"];
type MemorySourceOriginDatabase = {
  memory_index_sources: { path: string; source: MemorySource; hash: string };
  memory_index_chunks: { id: string; path: string; source: MemorySource };
  memory_index_chunk_provenance: { chunk_id: string; origin_class: MemoryOriginClass };
};

/** Runs on the existing publication worker's admitted connection and transaction. */
export function refreshMemorySourceOrigin(
  db: DatabaseSync,
  input: { path: string; expectedHash: string; originClass: MemoryOriginClass },
): boolean {
  const query = getNodeSqliteKysely<MemorySourceOriginDatabase>(db);
  const source = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("memory_index_sources")
      .select("hash")
      .where("source", "=", "memory")
      .where("path", "=", input.path),
  );
  if (source?.hash !== input.expectedHash) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    query
      .updateTable("memory_index_chunk_provenance")
      .set({ origin_class: input.originClass })
      .where("origin_class", "!=", input.originClass)
      .where(
        "chunk_id",
        "in",
        query
          .selectFrom("memory_index_chunks")
          .select("id")
          .where("source", "=", "memory")
          .where("path", "=", input.path),
      ),
  );
  return true;
}
