import type { DatabaseSync } from "node:sqlite";
import { type MemoryRef, memoryLocationId, memoryRefId } from "./ref.js";

export type SidecarStatus = "active" | "superseded" | "archived" | "deleted";

export type SidecarRecord = {
  refId: string;
  source: string;
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  memoryType: string | null;
  importance: number | null;
  salience: number | null;
  confidence: number | null;
  status: SidecarStatus;
  pinned: boolean;
  sourceKind: string | null;
  sourceRef: string | null;
  supersededBy: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastAccessedAt: number | null;
  consolidatedAt: number | null;
  locationId: string | null;
  schemaVersion: number;
};

export type SidecarPartial = {
  memoryType?: string | null;
  importance?: number | null;
  salience?: number | null;
  confidence?: number | null;
  status?: SidecarStatus;
  pinned?: boolean;
  sourceKind?: string | null;
  sourceRef?: string | null;
  supersededBy?: string | null;
  lastSeenAt?: number | null;
  consolidatedAt?: number | null;
};

type Row = {
  ref_id: string;
  source: string;
  path: string;
  start_line: number;
  end_line: number;
  content_hash: string;
  memory_type: string | null;
  importance: number | null;
  salience: number | null;
  confidence: number | null;
  status: string;
  pinned: number;
  source_kind: string | null;
  source_ref: string | null;
  superseded_by: string | null;
  created_at: number;
  last_seen_at: number | null;
  last_accessed_at: number | null;
  consolidated_at: number | null;
  location_id: string | null;
  schema_version: number;
};

function rowToRecord(row: Row): SidecarRecord {
  return {
    refId: row.ref_id,
    source: row.source,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    contentHash: row.content_hash,
    memoryType: row.memory_type,
    importance: row.importance,
    salience: row.salience,
    confidence: row.confidence,
    status: (row.status as SidecarStatus) ?? "active",
    pinned: row.pinned !== 0,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastAccessedAt: row.last_accessed_at,
    consolidatedAt: row.consolidated_at,
    locationId: row.location_id,
    schemaVersion: row.schema_version,
  };
}

// Insert if missing, update only fields the caller provided.
// `created_at` is preserved on update; `ref_id` is derived from the ref.
export function upsertRecord(
  db: DatabaseSync,
  ref: MemoryRef,
  partial: SidecarPartial,
  now: number,
): SidecarRecord {
  const refId = memoryRefId(ref);
  const existing = getByRefId(db, refId);

  if (!existing) {
    const locationId = memoryLocationId({
      source: ref.source,
      path: ref.path,
      startLine: ref.startLine,
      endLine: ref.endLine,
    });
    db.prepare(
      `INSERT INTO memory_v2_records (
         ref_id, source, path, start_line, end_line, content_hash,
         memory_type, importance, salience, confidence,
         status, pinned, source_kind, source_ref, superseded_by,
         created_at, last_seen_at, last_accessed_at, consolidated_at, location_id, schema_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      refId,
      ref.source,
      ref.path,
      ref.startLine,
      ref.endLine,
      ref.contentHash,
      partial.memoryType ?? null,
      partial.importance ?? null,
      partial.salience ?? null,
      partial.confidence ?? null,
      partial.status ?? "active",
      partial.pinned ? 1 : 0,
      partial.sourceKind ?? null,
      partial.sourceRef ?? null,
      partial.supersededBy ?? null,
      now,
      partial.lastSeenAt ?? null,
      null,
      partial.consolidatedAt ?? null,
      locationId,
    );
    const inserted = getByRefId(db, refId);
    if (!inserted) {
      throw new Error(`sidecar upsert insert failed for ${refId}`);
    }
    return inserted;
  }

  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const assign = (col: string, value: string | number | null) => {
    sets.push(`${col} = ?`);
    values.push(value);
  };
  if ("memoryType" in partial) {
    assign("memory_type", partial.memoryType ?? null);
  }
  if ("importance" in partial) {
    assign("importance", partial.importance ?? null);
  }
  if ("salience" in partial) {
    assign("salience", partial.salience ?? null);
  }
  if ("confidence" in partial) {
    assign("confidence", partial.confidence ?? null);
  }
  if ("status" in partial && partial.status !== undefined) {
    assign("status", partial.status);
  }
  if ("pinned" in partial && partial.pinned !== undefined) {
    assign("pinned", partial.pinned ? 1 : 0);
  }
  if ("sourceKind" in partial) {
    assign("source_kind", partial.sourceKind ?? null);
  }
  if ("sourceRef" in partial) {
    assign("source_ref", partial.sourceRef ?? null);
  }
  if ("supersededBy" in partial) {
    assign("superseded_by", partial.supersededBy ?? null);
  }
  if ("lastSeenAt" in partial) {
    assign("last_seen_at", partial.lastSeenAt ?? null);
  }
  if ("consolidatedAt" in partial) {
    assign("consolidated_at", partial.consolidatedAt ?? null);
  }

  if (sets.length > 0) {
    values.push(refId);
    db.prepare(`UPDATE memory_v2_records SET ${sets.join(", ")} WHERE ref_id = ?`).run(...values);
  }
  const updated = getByRefId(db, refId);
  if (!updated) {
    throw new Error(`sidecar upsert update failed for ${refId}`);
  }
  return updated;
}

export function getByRefId(db: DatabaseSync, refId: string): SidecarRecord | null {
  const row = db.prepare(`SELECT * FROM memory_v2_records WHERE ref_id = ?`).get(refId) as
    | Row
    | undefined;
  return row ? rowToRecord(row) : null;
}

export function listByRefIds(db: DatabaseSync, refIds: readonly string[]): SidecarRecord[] {
  if (refIds.length === 0) {
    return [];
  }
  const placeholders = refIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM memory_v2_records WHERE ref_id IN (${placeholders})`)
    .all(...refIds) as Row[];
  return rows.map(rowToRecord);
}

export function markStatus(db: DatabaseSync, refId: string, status: SidecarStatus): boolean {
  const result = db
    .prepare(`UPDATE memory_v2_records SET status = ? WHERE ref_id = ?`)
    .run(status, refId);
  return Number(result.changes) > 0;
}

export function setPinned(db: DatabaseSync, refId: string, pinned: boolean): boolean {
  const result = db
    .prepare(`UPDATE memory_v2_records SET pinned = ? WHERE ref_id = ?`)
    .run(pinned ? 1 : 0, refId);
  return Number(result.changes) > 0;
}

export function touchLastAccessed(db: DatabaseSync, refId: string, ts: number): boolean {
  const result = db
    .prepare(`UPDATE memory_v2_records SET last_accessed_at = ? WHERE ref_id = ?`)
    .run(ts, refId);
  return Number(result.changes) > 0;
}

export function deleteByRefId(db: DatabaseSync, refId: string): boolean {
  const result = db.prepare(`DELETE FROM memory_v2_records WHERE ref_id = ?`).run(refId);
  return Number(result.changes) > 0;
}
