import type { DatabaseSync } from "node:sqlite";
import { MEMORY_INDEX_META_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  admitSqliteSchema,
  openNodeSqliteDatabase,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePersistedMemoryVectorIndexState } from "./manager-vector-rebuild-state.js";

describe("persisted memory vector index state", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openNodeSqliteDatabase(":memory:");
    db.exec(`
      CREATE TABLE ${MEMORY_INDEX_META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY);
    `);
    admitSqliteSchema(db);
  });

  afterEach(() => db.close());

  it("trusts a clean published index even when an incremental first write has no dimensions metadata", () => {
    db.prepare(`INSERT INTO ${MEMORY_INDEX_META_TABLE} (key, value) VALUES (?, 'clean')`).run(
      "memory_vector_rebuild_v1",
    );

    const observed = observeHostDataSql();
    try {
      const read = () =>
        resolvePersistedMemoryVectorIndexState({
          db,
          vectorTable: "memory_index_chunks_vec",
          hasSemanticChunks: true,
        });
      expect(read()).toEqual({ state: "complete" });
      db.prepare(`DELETE FROM ${MEMORY_INDEX_META_TABLE} WHERE key = ?`).run(
        "memory_vector_rebuild_v1",
      );
      expect(read()).toEqual({ state: "incomplete" });
      expect(observed.queries.filter((sql) => /sqlite_(?:schema|master)/iu.test(sql))).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it("keeps a pre-marker vector index unverified", () => {
    expect(
      resolvePersistedMemoryVectorIndexState({
        db,
        vectorTable: "memory_index_chunks_vec",
        metaVectorDims: 768,
        hasSemanticChunks: true,
      }),
    ).toEqual({ state: "unverified" });
  });
});
