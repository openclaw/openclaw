import type { DatabaseSync } from "node:sqlite";
import { jaccard, tokenize } from "./normalize.js";

export const DEFAULT_JACCARD_THRESHOLD = 0.85;
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SCAN_CAP = 200;

export type DedupeOptions = {
  jaccardThreshold?: number;
  lookbackMs?: number;
  scanCap?: number;
};

export type DedupeMatch = {
  refId: string;
  similarity: number;
};

// Returns the highest-similarity active record of the same memory_type within
// the lookback window, if its Jaccard similarity meets the threshold.
//
// Bounded scan: the candidate pool is capped at `scanCap` rows ordered by
// most-recent last_seen_at first. If the pool is exactly `scanCap` we treat
// it as overflowed and skip lexical dedupe — Phase 1 prefers a duplicate slip
// to an unbounded scan cost.
export function findLexicalDuplicate(params: {
  db: DatabaseSync;
  memoryType: string;
  candidateText: string;
  now: number;
  options?: DedupeOptions;
}): DedupeMatch | null {
  const threshold = params.options?.jaccardThreshold ?? DEFAULT_JACCARD_THRESHOLD;
  const lookbackMs = params.options?.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const scanCap = params.options?.scanCap ?? DEFAULT_SCAN_CAP;

  const candidateTokens = tokenize(params.candidateText);
  if (candidateTokens.size === 0) {
    return null;
  }

  const since = params.now - lookbackMs;
  const rows = params.db
    .prepare(
      `SELECT r.ref_id AS ref_id, t.normalized_text AS normalized_text
         FROM memory_v2_records r
         JOIN memory_v2_ingest_text t ON t.ref_id = r.ref_id
        WHERE r.memory_type = ?
          AND r.status = 'active'
          AND COALESCE(r.last_seen_at, r.created_at) >= ?
        ORDER BY COALESCE(r.last_seen_at, r.created_at) DESC
        LIMIT ?`,
    )
    .all(params.memoryType, since, scanCap) as Array<{
    ref_id: string;
    normalized_text: string;
  }>;

  if (rows.length >= scanCap) {
    // Pool overflowed; skip dedupe to keep the call bounded.
    return null;
  }

  let best: DedupeMatch | null = null;
  for (const row of rows) {
    const sim = jaccard(candidateTokens, tokenize(row.normalized_text));
    if (sim >= threshold && (best === null || sim > best.similarity)) {
      best = { refId: row.ref_id, similarity: sim };
    }
  }
  return best;
}

export function upsertIngestText(db: DatabaseSync, refId: string, normalizedText: string): void {
  db.prepare(
    `INSERT INTO memory_v2_ingest_text (ref_id, normalized_text)
     VALUES (?, ?)
     ON CONFLICT(ref_id) DO UPDATE SET normalized_text = excluded.normalized_text`,
  ).run(refId, normalizedText);
}
