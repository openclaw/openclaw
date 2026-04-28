import type { DatabaseSync } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function deleteMemoryFtsRows(params: {
  db: DatabaseSync;
  tableName?: string;
  agentId: string;
  path: string;
  source: MemorySource;
  currentModel?: string;
}): void {
  const tableName = params.tableName ?? "chunks_fts";
  if (params.currentModel) {
    params.db
      .prepare(
        `DELETE FROM ${tableName} WHERE agent_id = ? AND path = ? AND source = ? AND model = ?`,
      )
      .run(params.agentId, params.path, params.source, params.currentModel);
    return;
  }
  params.db
    .prepare(`DELETE FROM ${tableName} WHERE agent_id = ? AND path = ? AND source = ?`)
    .run(params.agentId, params.path, params.source);
}
