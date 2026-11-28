// Memory Core plugin module owns the one-time unit-norm migration of a SQLite vector index.
import type { DatabaseSync } from "node:sqlite";
import {
  admitStoreSearch,
  type VectorCapability,
  type VectorIndex,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { stageMemoryIndexSchemaExtension } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  stageOpenClawAgentDatabaseSchemaExtension,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { memoryVectorSearchSchema } from "./manager-search-schema.js";
import { markMemoryVectorsUnitNorm, normalizeStoredEmbedding } from "./manager-vector-unit-norm.js";

/** Stored vectors whose norm differs from 1 by more than this are rewritten. */
const UNIT_NORM_TOLERANCE = 1e-5;
/** Rows per multi-row vector write; bounds statement size and memory. */
const WRITE_BATCH_SIZE = 256;

/** A copy: the driver's blob need not be 4-byte aligned for a Float32Array view. */
function readFloat32(blob: Uint8Array): Float32Array {
  const vector = new Float32Array(blob.byteLength / 4);
  new Uint8Array(vector.buffer).set(blob);
  return vector;
}

/** True unless the vector is unit length; NaN norms and vectors without a direction count. */
function needsNormalization(vector: Float32Array): boolean {
  let squared = 0;
  for (const value of vector) {
    squared += value * value;
  }
  return !(Math.abs(Math.sqrt(squared) - 1) <= UNIT_NORM_TOLERANCE);
}

/**
 * Make every stored vector unit length, drop vectors without a direction, then
 * set the marker. *vector* is this connection's admitted index, with sqlite-vec
 * loaded; *write* runs its callback in the publication write transaction.
 *
 * The scan that decides whether anything needs rewriting runs before the
 * write lock is taken, so providers that already normalize only pay for a
 * read and a one-row write. A table whose rows are not float32 vectors of the
 * index's dimensions is left untouched and unmarked (`false`).
 *
 * When some vectors need it, the vec0 table is rebuilt through the vector
 * capability (drop, create, write) with the schema admissions staged, as
 * `vector.ensure` does, rather than rewritten row by row. Rewriting rows, or
 * recreating the table on top of the pages it just freed, scatters vec0's
 * chunk blobs across the file: a cold KNN scan then turns into random reads,
 * 4–10x slower than on the original layout (#206960). With incremental
 * auto_vacuum, the freed pages are returned before the new table is written,
 * so its chunks are contiguous at the end of the file. Databases on
 * auto_vacuum NONE keep correct results with the slower layout. Like a full
 * reindex publication, the rebuild holds the write lock while it copies the
 * vectors twice.
 */
export function normalizeMemoryVectorsInPlace<R>(
  db: DatabaseSync,
  vector: { capability: VectorCapability; index: VectorIndex; dimensions?: number },
  write: (run: () => boolean) => R,
): R {
  const { capability, index, dimensions } = vector;
  if (!tableExists(db, index.table)) {
    return write(() => {
      markMemoryVectorsUnitNorm(db);
      return true;
    });
  }
  let rewrite = false;
  for (const row of db.prepare(`SELECT embedding FROM ${index.table}`).iterate()) {
    const blob = (row as { embedding?: unknown }).embedding;
    if (!(blob instanceof Uint8Array) || (dimensions && blob.byteLength !== dimensions * 4)) {
      // Not this release's FLOAT[dimensions] layout: never reinterpret it.
      return write(() => false);
    }
    rewrite ||= needsNormalization(readFloat32(blob));
  }
  if (!rewrite) {
    // Providers that already normalize: nothing to rewrite, the layout stays.
    return write(() => {
      markMemoryVectorsUnitNorm(db);
      return true;
    });
  }
  if (!dimensions || !Number.isSafeInteger(dimensions)) {
    return write(() => false);
  }
  return write(() => {
    stageMemoryIndexSchemaExtension(db);
    stageOpenClawAgentDatabaseSchemaExtension(db);
    const stage = `${index.table}_unit_norm_stage`;
    db.exec(`DROP TABLE IF EXISTS ${stage}`);
    db.exec(`CREATE TABLE ${stage} (id TEXT NOT NULL, embedding BLOB NOT NULL) STRICT`);
    db.exec(`INSERT INTO ${stage} (id, embedding) SELECT id, embedding FROM ${index.table}`);
    capability.drop(index);
    const autoVacuum = (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: unknown })
      ?.auto_vacuum;
    if (autoVacuum === 2) {
      // sqlite-allow-raw -- Return the dropped table's pages so the rebuilt chunks are contiguous.
      db.prepare("PRAGMA incremental_vacuum").all();
    }
    capability.create(index, dimensions);
    let batch: { id: string; embedding: number[] }[] = [];
    for (const row of db.prepare(`SELECT id, embedding FROM ${stage} ORDER BY rowid`).iterate()) {
      const { id, embedding } = row as { id: string; embedding: Uint8Array };
      const normalized = normalizeStoredEmbedding(Array.from(readFloat32(embedding)));
      if (normalized.length === dimensions) {
        batch.push({ id, embedding: normalized });
      }
      if (batch.length === WRITE_BATCH_SIZE) {
        capability.write(index, batch);
        batch = [];
      }
    }
    capability.write(index, batch);
    db.exec(`DROP TABLE ${stage}`);
    admitStoreSearch(db, memoryVectorSearchSchema(dimensions), { extension: "memory.vector" });
    markMemoryVectorsUnitNorm(db);
    return true;
  });
}
