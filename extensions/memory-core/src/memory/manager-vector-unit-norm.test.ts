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
import { advanceMemoryIndexRevision } from "../memory-index-revision.worker.js";
import { readMemoryDatabaseFacts } from "./manager-retrieval-read.js";
import { admitMemoryVectorIndex, searchMemoryVectorIndex } from "./manager-search-knn.js";
import { vectorToBlob } from "./manager-search-knn.test-support.js";
import { normalizeMemoryVectorsInPlace } from "./manager-vector-unit-norm-migration.worker.js";
import {
  clearMemoryVectorsUnitNorm,
  markMemoryVectorsUnitNorm,
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
      const vector = admitMemoryVectorIndex(db, table);
      vector.capability.create(vector.index, DIMS);
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

/** Runs the migration in a write transaction, as the publication worker does. */
function normalizeIndex(db: DatabaseSync, table = "memory_index_chunks_vec", dimensions = DIMS) {
  return normalizeMemoryVectorsInPlace(
    db,
    { ...admitMemoryVectorIndex(db, table), dimensions },
    (run) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  );
}

/** Changes whenever the vec0 table is rebuilt. */
const chunksRoot = (db: DatabaseSync) =>
  (
    db
      .prepare("SELECT rootpage FROM sqlite_master WHERE name = 'memory_index_chunks_vec_chunks'")
      .get() as { rootpage: number }
  ).rootpage;

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

  it("scores from vec0's L2 distance, not the stored vectors, when flagged", async () => {
    using db = await createVectorDb();
    // Deliberately non-unit rows: the flagged path must not reread them.
    const vectors = seededVectors(6);
    vectors.forEach((vector, index) => {
      insertChunk(db, `chunk-${index}`, vector);
      insertVector(db, "memory_index_chunks_vec", `chunk-${index}`, vector);
    });
    const [query] = seededVectors(1, 5);
    const unitQuery = query!.map((value) => value / norm(query!));
    const result = await knn(db, "memory_index_chunks_vec", query!, true);
    expect(result.rows).toHaveLength(6);
    for (const row of result.rows) {
      const stored = vectors[Number(row.id.slice("chunk-".length))]!;
      const l2Squared = stored.reduce((sum, value, i) => sum + (value - unitQuery[i]!) ** 2, 0);
      expect(row.dist).toBeCloseTo(l2Squared / 2, 4);
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

  it.each([
    ["NaN", [Number.NaN, ...Array.from({ length: DIMS - 1 }, () => 0)]],
    ["overflowing", Array.from({ length: DIMS }, () => 1e200)],
    ["tiny", [1e-12, ...Array.from({ length: DIMS - 1 }, () => 0)]],
  ])("gives a %s query vector zero similarity", async (_name, query) => {
    using db = await createVectorDb();
    seededVectors(3).forEach((vector, index) => {
      insertChunk(db, `chunk-${index}`, vector);
      insertVector(
        db,
        "memory_index_chunks_vec",
        `chunk-${index}`,
        normalizeStoredEmbedding(vector),
      );
    });
    const result = await knn(db, "memory_index_chunks_vec", query, true);
    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) {
      expect(row.dist).toBe(1);
    }
  });

  it("does not store vectors without a usable direction", () => {
    expect(normalizeStoredEmbedding([0, 0, 0])).toEqual([]);
    expect(normalizeStoredEmbedding([Number.NaN, 0])).toEqual([]);
    // Too small for sanitizeAndNormalizeEmbedding to normalize; stored as is it would score 0.5.
    expect(normalizeStoredEmbedding([1e-12, 0])).toEqual([]);
    expect(normalizeStoredEmbedding([1e200, 1e200])).toEqual([]);
    expect(normalizeStoredEmbedding([3, 4])).toEqual([0.6, 0.8]);
    expect(normalizeStoredEmbedding([Number.POSITIVE_INFINITY, 2])).toEqual([0, 1]);
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

      expect(normalizeIndex(db)).toBe(true);
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

      // Already unit length: marked again without a rebuild.
      const root = chunksRoot(db);
      clearMemoryVectorsUnitNorm(db);
      expect(normalizeIndex(db)).toBe(true);
      expect(chunksRoot(db)).toBe(root);
      expect(readMemoryVectorsUnitNorm(db)).toBe(true);
    },
  );

  it("drops stored vectors without a direction and repairs NaN coordinates", async () => {
    using db = await createVectorDb();
    const table = "memory_index_chunks_vec";
    const zeros = Array.from({ length: DIMS }, () => 0);
    insertVector(db, table, "tiny", [1e-12, ...zeros.slice(1)]);
    insertVector(db, table, "nan", [Number.NaN, 2, ...zeros.slice(2)]);
    insertVector(db, table, "unit", [1, ...zeros.slice(1)]);
    expect(normalizeIndex(db)).toBe(true);
    expect(db.prepare(`SELECT id FROM ${table} WHERE id = 'tiny'`).get()).toBeUndefined();
    expect(Array.from(readVector(db, table, "nan"))).toEqual([0, 1, ...zeros.slice(2)]);
    expect(Array.from(readVector(db, table, "unit"))).toEqual([1, ...zeros.slice(1)]);
    expect(readMemoryVectorsUnitNorm(db)).toBe(true);
  });

  it("writes large indexes in bounded batches", async () => {
    using db = await createVectorDb();
    const vectors = seededVectors(600);
    vectors.forEach((vector, index) =>
      insertVector(db, "memory_index_chunks_vec", `v-${index}`, vector),
    );
    expect(normalizeIndex(db)).toBe(true);
    const ids = db.prepare("SELECT id FROM memory_index_chunks_vec").all() as { id: string }[];
    expect(ids).toHaveLength(600);
    const sample = readVector(db, "memory_index_chunks_vec", "v-599");
    expect(norm(sample)).toBeCloseTo(1, 5);
    const scale = norm(vectors[599]!);
    vectors[599]!.forEach((value, index) => expect(sample[index]).toBeCloseTo(value / scale, 5));
  });

  it("leaves a table that is not FLOAT[dimensions] untouched and unmarked", async () => {
    using db = await createVectorDb();
    const table = "memory_index_chunks_vec";
    const [raw] = seededVectors(2);
    insertVector(db, table, "raw", raw!);
    const root = chunksRoot(db);
    // The index metadata claims another width: never reinterpret the stored bytes.
    expect(normalizeIndex(db, table, DIMS / 2)).toBe(false);
    expect(chunksRoot(db)).toBe(root);
    expect(Array.from(readVector(db, table, "raw"))).toEqual(Array.from(new Float32Array(raw!)));
    expect(readMemoryVectorsUnitNorm(db)).toBe(false);
  });

  it("marks a database without a vector table", async () => {
    using db = await createVectorDb([]);
    expect(normalizeIndex(db)).toBe(true);
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

  it("carries the marker across this release's revisions and drops it for foreign writers", async () => {
    using db = await createVectorDb([]);
    markMemoryVectorsUnitNorm(db);
    advanceMemoryIndexRevision(db);
    advanceMemoryIndexRevision(db);
    expect(readMemoryVectorsUnitNorm(db)).toBe(true);
    expect(readMemoryDatabaseFacts(db).vectorUnitNorm).toBe(true);
    // An earlier release advances the revision without carrying the marker.
    db.exec("UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1");
    expect(readMemoryVectorsUnitNorm(db)).toBe(false);
    expect(readMemoryDatabaseFacts(db).vectorUnitNorm).toBe(false);
    // A stale marker is not revived by later revisions of this release.
    advanceMemoryIndexRevision(db);
    expect(readMemoryVectorsUnitNorm(db)).toBe(false);
    markMemoryVectorsUnitNorm(db);
    expect(readMemoryVectorsUnitNorm(db)).toBe(true);
  });
});
