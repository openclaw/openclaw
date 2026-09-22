import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "openclaw/plugin-sdk/sqlite-runtime";

type MemoryIndexSource = { path: string; source: string };

// The forget owner supplies its selected rows and retains the purge transaction.
export function deleteMemoryIndexSources(
  database: DatabaseSync,
  sources: readonly MemoryIndexSource[],
): void {
  const db = getNodeSqliteKysely<{ memory_index_sources: MemoryIndexSource }>(database);
  for (let start = 0; start < sources.length;) {
    const source = sources[start]!;
    let end = start + 1;
    while (end < sources.length && sources[end]!.source === source.source) {
      end += 1;
    }
    executeSqliteQuerySync(
      database,
      db
        .deleteFrom("memory_index_sources")
        .where("path", "in", sqliteStringSet(sources.slice(start, end).map((row) => row.path)))
        .where("source", "=", source.source),
    );
    start = end;
  }
}
