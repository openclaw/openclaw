import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";

const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

/** Inspect existing memory tables without constructing or migrating a manager. */
export function inspectMemoryIndexPresenceInWorker(databasePath: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = openNodeSqliteDatabase(databasePath, { readOnly: true });
    const builtInMemoryTableSets = [
      {
        meta: MEMORY_INDEX_META_TABLE,
        sources: MEMORY_INDEX_SOURCES_TABLE,
        chunks: MEMORY_INDEX_CHUNKS_TABLE,
      },
      { meta: "meta", sources: "files", chunks: "chunks" },
    ] as const;
    const builtInMemoryTables = builtInMemoryTableSets.flatMap(({ meta, sources, chunks }) => [
      meta,
      sources,
      chunks,
    ]);
    const tableNames = new Set(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${builtInMemoryTables.map(() => "?").join(", ")})`,
        )
        .all(...builtInMemoryTables)
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    for (const tables of builtInMemoryTableSets) {
      if (
        tableNames.has(tables.meta) &&
        db
          .prepare(`SELECT 1 AS ok FROM ${tables.meta} WHERE key = ? LIMIT 1`)
          .get(MEMORY_INDEX_META_KEY)
      ) {
        return true;
      }
      for (const tableName of [tables.sources, tables.chunks]) {
        if (
          tableNames.has(tableName) &&
          db.prepare(`SELECT 1 AS ok FROM ${tableName} LIMIT 1`).get()
        ) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}
