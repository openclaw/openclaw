import {
  ensureSqliteLibrarySelected,
  openNodeSqliteDatabase,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { runVectorKnnQuery } from "./manager-search-knn.js";
import { vectorToBlob } from "./vector-blob.js";

describe("memory vector KNN decision counts", () => {
  it("runs KNN before chunk lookup even when planner statistics favor chunks", async () => {
    ensureSqliteLibrarySelected();
    const db = openNodeSqliteDatabase(":memory:", { allowExtension: true });
    try {
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY, embedding FLOAT[2]
      )`);
      const insertChunk = db.prepare(
        `INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, 'memory', 1, 1, ?, 'target', ?, '[1,0]', 1)`,
      );
      const insertVector = db.prepare(
        "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
      );
      const vector = vectorToBlob([1, 0]);
      db.exec("BEGIN");
      for (let index = 0; index < 100; index += 1) {
        const id = `chunk-${index}`;
        insertChunk.run(id, `memory/${id}.md`, id, `text ${id}`);
        insertVector.run(id, vector);
      }
      db.exec("COMMIT; ANALYZE");

      // Reproduce a planner state where the chunks table looks cheaper to scan.
      // The query must keep sqlite-vec outermost instead of trusting that estimate.
      db.exec(`
        UPDATE sqlite_stat1 SET stat = '1 1' WHERE tbl = 'memory_index_chunks';
        ANALYZE sqlite_schema;
      `);
      let vectorVisits = 0;
      db.function("visit_vector", { varargs: true }, () => {
        vectorVisits += 1;
        return 1;
      });
      db.exec(`
        CREATE TEMP VIEW observed_vectors AS
          SELECT id, embedding, distance, k FROM main.memory_index_chunks_vec
          WHERE visit_vector(id);
      `);

      const result = runVectorKnnQuery(db, {
        vectorTable: "observed_vectors",
        providerModels: ["target"],
        queryVec: [1, 0],
        limit: 5,
        snippetMaxChars: 20,
        sourceFilter: { sql: "", params: [] },
      });

      expect(result.fallbackScanRequired).toBe(false);
      expect(result.rows).toHaveLength(5);
      expect(vectorVisits).toBe(40);
    } finally {
      db.close();
    }
  });

  it("stops counting after fallback is decided without enumerating the remaining rows", async () => {
    ensureSqliteLibrarySelected();
    const db = openNodeSqliteDatabase(":memory:", { allowExtension: true });
    try {
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY, embedding FLOAT[2]
      )`);
      const insertChunk = db.prepare(
        `INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, 'memory', 1, 1, ?, ?, ?, ?, 1)`,
      );
      const insertVector = db.prepare(
        "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
      );
      db.exec("BEGIN");
      for (let index = 0; index < 6000; index += 1) {
        const id = `chunk-${index}`;
        const model = index < 1000 ? "target" : "other";
        const vector = index < 1000 ? [0, 1] : [1, 0];
        insertChunk.run(id, `memory/${id}.md`, id, model, `text ${id}`, JSON.stringify(vector));
        insertVector.run(id, vectorToBlob(vector));
      }
      db.exec("COMMIT");
      let chunkVisits = 0;
      let vectorVisits = 0;
      db.function("visit_chunk", { varargs: true }, () => {
        chunkVisits += 1;
        return 1;
      });
      db.function("visit_vector", { varargs: true }, () => {
        vectorVisits += 1;
        return 1;
      });
      // Transparent views observe native row visits, including KNN, without
      // changing stored rows or replacing the real sqlite-vec query engine.
      db.exec(`
        CREATE TEMP VIEW memory_index_chunks AS
          SELECT * FROM main.memory_index_chunks WHERE visit_chunk(id);
        CREATE TEMP VIEW observed_vectors AS
          SELECT id, embedding, distance, k FROM main.memory_index_chunks_vec
          WHERE visit_vector(id);
      `);
      expect(
        runVectorKnnQuery(db, {
          vectorTable: "observed_vectors",
          providerModels: ["target"],
          queryVec: [1, 0],
          limit: 2,
          snippetMaxChars: 20,
          sourceFilter: { sql: "", params: [] },
        }),
      ).toEqual({ rows: [], fallbackScanRequired: true });
      // Two KNN attempts visit at most 16 + 4,096 rows. Decision counts need
      // only two matching chunks and 4,097 vectors, regardless of the tail.
      expect(chunkVisits).toBeGreaterThan(0);
      expect(vectorVisits).toBeGreaterThan(0);
      expect(chunkVisits).toBeLessThanOrEqual(4114);
      expect(vectorVisits).toBeLessThanOrEqual(8209);
    } finally {
      db.close();
    }
  });
});
