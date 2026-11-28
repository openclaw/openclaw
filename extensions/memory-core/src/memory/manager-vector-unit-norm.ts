// Memory Core plugin module owns the unit-norm guarantee for stored vectors.
import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { sanitizeAndNormalizeEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { MEMORY_INDEX_META_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-schema";

/**
 * Holds the memory index revision at which every row of the SQLite vector
 * table was known to have unit L2 norm; any other value means "unknown".
 *
 * Cosine distance is scale-invariant, so normalizing a stored vector never
 * changes search results. With unit vectors, cosine distance equals
 * L2² / 2, which vec0 returns with each KNN candidate: search can then skip
 * rereading every candidate's embedding (`vec_distance_cosine`).
 *
 * Writers of this release normalize every vector, and this release's
 * `advanceMemoryIndexRevision` carries a current marker to the new revision.
 * Writers that do not normalize (an earlier release, after a downgrade or
 * beside a newer one) advance the revision without carrying the marker, so
 * it goes stale and search falls back to the exact cosine expression until
 * the next sync verifies the vectors again. The marker is set by publishing
 * a full reindex or by that verification
 * (manager-vector-unit-norm-migration.worker.ts), and cleared by doctor's
 * legacy import, which copies vectors without normalizing them.
 */
export const VECTOR_UNIT_NORM_META_KEY = "memory_vector_unit_norm_v1";

/**
 * Vectors stored by this release: sanitized and L2-normalized. A vector with
 * no usable direction (zero, too small to normalize, or overflowing) has no
 * cosine similarity to anything, so it is not stored: an empty result, which
 * writers already treat as "no vector for this chunk".
 */
export function normalizeStoredEmbedding(embedding: readonly number[]): number[] {
  const normalized = sanitizeAndNormalizeEmbedding([...embedding]);
  let squared = 0;
  for (const value of normalized) {
    squared += value * value;
  }
  return Math.abs(Math.sqrt(squared) - 1) <= 1e-6 ? normalized : [];
}

/** The marker is current: it names the index revision this connection reads. */
export function readMemoryVectorsUnitNorm(db: EngineConnection): boolean {
  const row = db
    .prepare(
      `SELECT value, (SELECT revision FROM memory_index_state WHERE id = 1) AS revision
       FROM ${MEMORY_INDEX_META_TABLE} WHERE key = ?`,
    )
    .get(VECTOR_UNIT_NORM_META_KEY) as { value?: unknown; revision?: unknown } | undefined;
  return isCurrentMemoryVectorsUnitNorm(row?.value, row?.revision);
}

export function isCurrentMemoryVectorsUnitNorm(marker: unknown, revision: unknown): boolean {
  return typeof marker === "string" && marker === String(revision);
}

/** Records that every stored vector is unit length at the current index revision. */
export function markMemoryVectorsUnitNorm(db: EngineConnection): void {
  db.prepare(
    `INSERT INTO ${MEMORY_INDEX_META_TABLE} (key, value)
     VALUES (?, CAST((SELECT revision FROM memory_index_state WHERE id = 1) AS TEXT))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(VECTOR_UNIT_NORM_META_KEY);
}

export function clearMemoryVectorsUnitNorm(db: EngineConnection): void {
  db.prepare(`DELETE FROM ${MEMORY_INDEX_META_TABLE} WHERE key = ?`).run(VECTOR_UNIT_NORM_META_KEY);
}
