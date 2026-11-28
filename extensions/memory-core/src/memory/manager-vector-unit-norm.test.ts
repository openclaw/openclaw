import type { DatabaseSync } from "node:sqlite";
import {
  ensureSqliteLibrarySelected,
  openNodeSqliteDatabase,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { admitMemoryVectorIndex, searchMemoryVectorIndex } from "./manager-search-knn.js";
import { vectorToBlob } from "./manager-search-knn.test-support.js";
import {
  clearMemoryVectorsUnitNorm,
  markMemoryVectorsUnitNorm,
  normalizeMemoryVectorsInPlace,
  normalizeStoredEmbedding,
  readMemoryVectorsUnitNorm,
} from "./manager-vector-unit-norm.js";

const DIMS = 16;

/** Deterministic, non-unit vectors (norms spread well away from 1). */
function seededVectors(count: number, seed = 7): number[][] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31 - 0.5;
  };
  return Array.from({ length: count }, (_, row) => {
    const scale = 0.1 + row * 0.37;
    return Array.from({ length: DIMS }, () => next() * scale);
  });
}

const norm = (vector: ArrayLike<number>) => Math.hypot(...Array.from(vector));

async function createVectorDb(
  tables: readonly string[] = ["memory_index_chunks_vec"],
  autoVacuum: "NONE" | "INCREMENTAL" = "NONE",
) {
  ensureSqliteLibrarySelected();
  const db = openNodeSqliteDatabase(":memory:", { allowExtension: true });
  try {
    db.exec(`PRAGMA auto_vacuum = ${autoVacuum}`);
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    for (const table of tables) {
      db.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(
        id TEXT PRIMARY KEY, embedding FLOAT[${DIMS}]
      )`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function insertChunk(db: DatabaseSync, id: string, vector: number[]) {
  db.prepare(`INSERT INTO memory_index_chunks
    (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
    VALUES (?, ?, 'memory', 1, 1, ?, 'target-model', ?, ?, 1)`).run(
    id,
    `memory/${id}.md`,
    id,
    `chunk ${id}`,
    encodeMemoryEmbedding(vector),
  );
}

function insertVector(db: DatabaseSync, table: string, id: string, vector: number[]) {
  db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ?)`).run(id, vectorToBlob(vector));
}

function readVector(db: DatabaseSync, table: string, id: string): Float32Array {
  const blob = (
    db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as {
      embedding: Uint8Array;
    }
  ).embedding;
  const vector = new Float32Array(blob.byteLength / 4);
  new Uint8Array(vector.buffer).set(blob);
  return vector;
}

function knn(db: DatabaseSync, table: string, queryVec: number[], unitNormVectors: boolean) {
  const search = admitMemoryVectorIndex(db, table);
  return searchMemoryVectorIndex(
    search.capability,
    search.index,
    {
      providerModels: ["target-model"],
      queryVec,
      limit: 10,
      snippetMaxChars: 20,
      sourceFilter: { sql: "", params: [] },
    },
    { unitNormVectors },
  );
}

describe("unit-norm vector search", () => {
  it("matches vec_distance_cosine on raw vectors for non-unit queries", async () => {
    using db = await createVectorDb(["raw_vec", "unit_vec"]);
    const vectors = seededVectors(24);
    vectors.forEach((vector, index) => {
      const id = `chunk-${index}`;
      insertChunk(db, id, vector);
      insertVector(db, "raw_vec", id, vector);
      insertVector(db, "unit_vec", id, normalizeStoredEmbedding(vector));
    });

    for (const query of seededVectors(5, 99)) {
      expect(Math.abs(norm(query) - 1)).toBeGreaterThan(0.01);
      // The baseline reranks raw vectors with vec_distance_cosine; candidates
      // come from raw L2, so compare with every vector as a candidate (k=80 > 24).
      const baseline = await knn(db, "raw_vec", query, false);
      const unit = await knn(db, "unit_vec", query, true);
      expect(unit.fallbackScanRequired).toBe(false);
      expect(unit.rows.map((row) => row.id)).toEqual(baseline.rows.map((row) => row.id));
      unit.rows.forEach((row, index) => {
        expect(row.dist).toBeCloseTo(baseline.rows[index]!.dist, 5);
      });
    }
  });

  it("gives a zero query vector zero similarity, as the fallback scorer does", async () => {
    using db = await createVectorDb();
    seededVectors(4).forEach((vector, index) => {
      insertChunk(db, `chunk-${index}`, vector);
      insertVector(
        db,
        "memory_index_chunks_vec",
        `chunk-${index}`,
        normalizeStoredEmbedding(vector),
      );
    });
    const result = await knn(
      db,
      "memory_index_chunks_vec",
      Array.from({ length: DIMS }, () => 0),
      true,
    );
    expect(result.rows).toHaveLength(4);
    for (const row of result.rows) {
      expect(row.dist).toBe(1);
    }
  });

  it("does not store zero vectors, which have no direction", () => {
    expect(normalizeStoredEmbedding([0, 0, 0])).toEqual([]);
    expect(normalizeStoredEmbedding([Number.NaN, 0])).toEqual([]);
    expect(normalizeStoredEmbedding([3, 4])).toEqual([0.6, 0.8]);
  });
});

describe("normalizeMemoryVectorsInPlace", () => {
  it.each(["NONE", "INCREMENTAL"] as const)(
    "rebuilds non-unit vectors, drops zero vectors, and sets the marker (auto_vacuum=%s)",
    async (autoVacuum) => {
      using db = await createVectorDb(["memory_index_chunks_vec"], autoVacuum);
      const table = "memory_index_chunks_vec";
      const ddl = () =>
        db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string };
      const before = ddl();
      const [a, b] = seededVectors(2);
      const unit = normalizeStoredEmbedding(seededVectors(1, 3)[0]!);
      insertVector(db, table, "raw-a", a!);
      insertVector(db, table, "raw-b", b!);
      insertVector(db, table, "unit", unit);
      insertVector(
        db,
        table,
        "zero",
        Array.from({ length: DIMS }, () => 0),
      );
      expect(readMemoryVectorsUnitNorm(db)).toBe(false);

      expect(normalizeMemoryVectorsInPlace(db)).toEqual({ scanned: 4, rewritten: 3 });
      expect(readMemoryVectorsUnitNorm(db)).toBe(true);
      for (const id of ["raw-a", "raw-b", "unit"]) {
        expect(norm(readVector(db, table, id))).toBeCloseTo(1, 5);
      }
      // Unit-norm scoring would give a zero vector similarity 0.5; it is dropped instead.
      expect(db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get("zero")).toBeUndefined();
      // Direction is preserved.
      const rewritten = readVector(db, table, "raw-a");
      const scale = norm(a!);
      a!.forEach((value, index) => expect(rewritten[index]).toBeCloseTo(value / scale, 5));

      expect(ddl()).toEqual(before);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%unit_norm_stage%'").all(),
      ).toEqual([]);
      for (const id of ["raw-a", "raw-b", "unit"]) {
        insertChunk(db, id, Array.from(readVector(db, table, id)));
      }
      const hits = await knn(db, table, a!, true);
      expect(hits.rows[0]?.id).toBe("raw-a");
      expect(hits.rows[0]?.dist).toBeCloseTo(0, 5);

      expect(normalizeMemoryVectorsInPlace(db)).toEqual({ scanned: 3, rewritten: 0 });
    },
  );

  it("marks a database without a vector table", async () => {
    using db = await createVectorDb([]);
    expect(normalizeMemoryVectorsInPlace(db)).toEqual({ scanned: 0, rewritten: 0 });
    expect(readMemoryVectorsUnitNorm(db)).toBe(true);
  });

  it("clears and re-marks the marker", async () => {
    using db = await createVectorDb([]);
    markMemoryVectorsUnitNorm(db);
    markMemoryVectorsUnitNorm(db);
    expect(readMemoryVectorsUnitNorm(db)).toBe(true);
    clearMemoryVectorsUnitNorm(db);
    expect(readMemoryVectorsUnitNorm(db)).toBe(false);
  });
});
