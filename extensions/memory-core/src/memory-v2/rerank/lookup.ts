import type { DatabaseSync } from "node:sqlite";
import type { SidecarStatus } from "../sidecar-repo.js";
import type { RerankSignals } from "./types.js";

type Row = {
  location_id: string;
  salience: number | null;
  pinned: number;
  status: string;
  last_accessed_at: number | null;
};

// Batched signal lookup keyed by location_id. One indexed query, no N+1.
//
// If multiple sidecar rows ever share a location_id (Slice 1.5's
// recordTouchedLocations is defensive against this, but the column is not
// UNIQUE), the row with the highest salience wins, ties broken by most
// recently accessed. This keeps the choice deterministic for tests.
export function loadSidecarSignalsByLocations(
  db: DatabaseSync,
  locationIds: readonly string[],
): Map<string, RerankSignals> {
  const out = new Map<string, RerankSignals>();
  if (locationIds.length === 0) {
    return out;
  }

  const placeholders = locationIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT location_id, salience, pinned, status, last_accessed_at
         FROM memory_v2_records
        WHERE location_id IN (${placeholders})`,
    )
    .all(...locationIds) as Row[];

  for (const row of rows) {
    const candidate: RerankSignals = {
      salience: row.salience,
      pinned: row.pinned !== 0,
      status: (row.status as SidecarStatus) ?? "active",
      lastAccessedAt: row.last_accessed_at,
    };
    const existing = out.get(row.location_id);
    if (!existing || preferCandidate(existing, candidate)) {
      out.set(row.location_id, candidate);
    }
  }
  return out;
}

function preferCandidate(existing: RerankSignals, candidate: RerankSignals): boolean {
  const e = existing.salience ?? -1;
  const c = candidate.salience ?? -1;
  if (c !== e) {
    return c > e;
  }
  return (candidate.lastAccessedAt ?? 0) > (existing.lastAccessedAt ?? 0);
}
