// Memory Core plugin module implements manager fts state behavior.
import type { DatabaseSync } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function deleteMemoryFtsRows(params: {
  db: DatabaseSync;
  tableName?: string;
  path: string;
  source: MemorySource;
  currentModel?: string;
}): void {
<<<<<<< HEAD
  const tableName = params.tableName ?? "memory_index_chunks_fts";
=======
  const tableName = params.tableName ?? "chunks_fts";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  // Lexical search is model-agnostic, so refreshed/deleted files must not
  // leave old-model FTS rows behind for the same path/source.
  params.db
    .prepare(`DELETE FROM ${tableName} WHERE path = ? AND source = ?`)
    .run(params.path, params.source);
}
