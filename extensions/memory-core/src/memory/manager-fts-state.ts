import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_INDEX_TABLE_NAMES,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function deleteMemoryFtsRows(params: {
  db: DatabaseSync;
  tableName?: string;
  path: string;
  source: MemorySource;
  currentModel?: string;
}): void {
  const tableName = params.tableName ?? MEMORY_INDEX_TABLE_NAMES.fts;
  if (params.currentModel) {
    params.db
      .prepare(`DELETE FROM ${tableName} WHERE path = ? AND source = ? AND model = ?`)
      .run(params.path, params.source, params.currentModel);
    return;
  }
  params.db
    .prepare(`DELETE FROM ${tableName} WHERE path = ? AND source = ?`)
    .run(params.path, params.source);
}
