// Memory Core plugin module owns the unit-norm guarantee for stored vectors.
import type { DatabaseSync } from "node:sqlite";
import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { sanitizeAndNormalizeEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { tableExists } from "openclaw/plugin-sdk/sqlite-worker-runtime";

/**
 * Present ('1') when every row of the SQLite vector table has unit L2 norm.
 *
 * Cosine distance is scale-invariant, so normalizing a stored vector never
 * changes search results. With unit vectors, cosine distance equals
 * L2² / 2, which vec0 returns with each KNN candidate: search can then skip
 * rereading every candidate's embedding (`vec_distance_cosine`).
 *
 * Writers of this release normalize every vector. The marker is set only by
 * the in-place pass or by publishing a full reindex, and cleared by any path
 * that inserts vectors without normalizing them.
 */
export const VECTOR_UNIT_NORM_META_KEY = "memory_vector_unit_norm_v1";

/** Stored vectors whose norm differs from 1 by more than this are rewritten. */
const UNIT_NORM_TOLERANCE = 1e-5;

/** Vectors stored by this release: sanitized and L2-normalized. */
export function normalizeStoredEmbedding(embedding: number[]): number[] {
  return sanitizeAndNormalizeEmbedding(embedding);
}

export function readMemoryVectorsUnitNorm(db: EngineConnection): boolean {
  const row = db
    .prepare(`SELECT value FROM ${MEMORY_INDEX_META_TABLE} WHERE key = ?`)
    .get(VECTOR_UNIT_NORM_META_KEY) as { value?: unknown } | undefined;
  return row?.value === "1";
}

export function markMemoryVectorsUnitNorm(db: EngineConnection): void {
  db.prepare(
    `INSERT INTO ${MEMORY_INDEX_META_TABLE} (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(VECTOR_UNIT_NORM_META_KEY);
}

export function clearMemoryVectorsUnitNorm(db: EngineConnection): void {
  db.prepare(`DELETE FROM ${MEMORY_INDEX_META_TABLE} WHERE key = ?`).run(VECTOR_UNIT_NORM_META_KEY);
}

/** A copy: the driver's blob need not be 4-byte aligned for a Float32Array view. */
function readFloat32(blob: Uint8Array): Float32Array {
  const vector = new Float32Array(blob.byteLength / 4);
  new Uint8Array(vector.buffer).set(blob);
  return vector;
}

function l2Norm(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) {
    squared += value * value;
  }
  return Math.sqrt(squared);
}

/** A stored vector that the unit-norm path cannot score exactly as stored. */
function needsNormalization(vector: Float32Array): boolean {
  const norm = l2Norm(vector);
  // A zero vector has no direction; it stays as stored, as on write.
  return norm >= 1e-10 && Math.abs(norm - 1) > UNIT_NORM_TOLERANCE;
}

function toStoredBlob(vector: Float32Array): Buffer {
  if (!needsNormalization(vector)) {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  }
  return Buffer.from(new Float32Array(normalizeStoredEmbedding(Array.from(vector))).buffer);
}

/**
 * Make every stored vector unit length, then set the marker. The caller holds
 * the write transaction and has sqlite-vec loaded on *db*.
 *
 * When some vectors need it, the vec0 table is rebuilt from its own DDL
 * rather than rewritten row by row. Rewriting rows, or recreating the table
 * on top of the pages it just freed, scatters vec0's chunk blobs across the
 * file: a cold KNN scan then turns into random reads, 4–10x slower than on
 * the original layout. With incremental auto_vacuum, the freed pages are
 * returned before the new table is written, so its chunks are contiguous at
 * the end of the file.
 */
export function normalizeMemoryVectorsInPlace(
  db: DatabaseSync,
  table = MEMORY_INDEX_VECTOR_TABLE,
): { scanned: number; rewritten: number } {
  if (!tableExists(db, table)) {
    markMemoryVectorsUnitNorm(db);
    return { scanned: 0, rewritten: 0 };
  }
  let scanned = 0;
  let rewritten = 0;
  for (const row of db.prepare(`SELECT embedding FROM ${table}`).iterate()) {
    scanned += 1;
    const blob = (row as { embedding?: unknown }).embedding;
    if (
      blob instanceof Uint8Array &&
      blob.byteLength % 4 === 0 &&
      needsNormalization(readFloat32(blob))
    ) {
      rewritten += 1;
    }
  }
  if (rewritten === 0) {
    // Providers that already normalize: nothing to rewrite, the layout stays.
    markMemoryVectorsUnitNorm(db);
    return { scanned, rewritten };
  }
  const ddl = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { sql?: unknown }
      | undefined
  )?.sql;
  if (typeof ddl !== "string") {
    throw new Error(`Memory vector table ${table} has no stored definition`);
  }
  const stage = `${table}_unit_norm_stage`;
  db.exec(`DROP TABLE IF EXISTS ${stage}`);
  db.exec(`CREATE TABLE ${stage} (id TEXT NOT NULL, embedding BLOB NOT NULL)`);
  db.exec(`INSERT INTO ${stage} (id, embedding) SELECT id, embedding FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  const autoVacuum = (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: unknown })
    ?.auto_vacuum;
  if (autoVacuum === 2) {
    // sqlite-allow-raw -- Return the dropped table's pages so the rebuilt chunks are contiguous.
    db.prepare("PRAGMA incremental_vacuum").all();
  }
  db.exec(ddl);
  const insert = db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ?)`);
  for (const row of db.prepare(`SELECT id, embedding FROM ${stage} ORDER BY rowid`).iterate()) {
    const { id, embedding } = row as { id: string; embedding: Uint8Array };
    insert.run(
      id,
      embedding.byteLength % 4 === 0 ? toStoredBlob(readFloat32(embedding)) : embedding,
    );
  }
  db.exec(`DROP TABLE ${stage}`);
  markMemoryVectorsUnitNorm(db);
  return { scanned, rewritten };
}
