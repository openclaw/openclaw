import type { DatabaseSync } from "node:sqlite";
import { type MemorySource, memoryLocationId, memoryRefId } from "../ref.js";

// Minimal subset of MemorySearchResult that the touch helper needs. Defined
// locally so this module does not need to import from outside the extension.
// The Slice 2 wrapper will adapt MemorySearchResult into this shape inline.
export type TouchableHit = {
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
};

export type LocationTouchOutcome = {
  inspected: number;
  inserted: number;
  refreshed: number;
};

// First-touch shadow writer. For each hit whose location_id is not already
// present in the sidecar, insert a stub row keyed by location_id. For hits
// whose location_id is already present, refresh `last_accessed_at` so future
// rerank can boost recently-surfaced rows.
//
// This function is intentionally NOT wired to any hot path in Slice 1.5. The
// Slice 2 rerank wrapper is the only intended caller. It is safe to invoke
// outside a transaction; multi-process contention is bounded by the existing
// PRAGMA busy_timeout on the shared sidecar opener.
export function recordTouchedLocations(
  db: DatabaseSync,
  hits: readonly TouchableHit[],
  now: number,
): LocationTouchOutcome {
  const outcome: LocationTouchOutcome = { inspected: 0, inserted: 0, refreshed: 0 };
  if (hits.length === 0) {
    return outcome;
  }

  const select = db.prepare(`SELECT ref_id FROM memory_v2_records WHERE location_id = ? LIMIT 1`);
  const refresh = db.prepare(
    `UPDATE memory_v2_records SET last_accessed_at = ? WHERE location_id = ?`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_v2_records (
       ref_id, source, path, start_line, end_line, content_hash,
       status, pinned, source_kind, created_at, last_accessed_at, location_id, schema_version
     ) VALUES (?, ?, ?, ?, ?, '', 'active', 0, 'indexed', ?, ?, ?, 1)`,
  );

  for (const hit of hits) {
    outcome.inspected++;
    const locationId = memoryLocationId(hit);
    const existing = select.get(locationId) as { ref_id: string } | undefined;
    if (existing) {
      refresh.run(now, locationId);
      outcome.refreshed++;
      continue;
    }
    // Use a synthetic refId derived from the location-only tuple so a future
    // ingest (which carries a real contentHash) can still insert its own row
    // without colliding. The shadow ref intentionally uses an empty hash.
    const shadowRefId = memoryRefId({
      source: hit.source,
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      contentHash: "",
    });
    insert.run(shadowRefId, hit.source, hit.path, hit.startLine, hit.endLine, now, now, locationId);
    outcome.inserted++;
  }
  return outcome;
}
