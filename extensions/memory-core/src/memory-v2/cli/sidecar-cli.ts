import type { DatabaseSync } from "node:sqlite";
import { markStatus, setPinned, setSalience, type SidecarStatus } from "../sidecar-repo.js";

export type { SidecarStatus };

export const SIDECAR_STATUS_VALUES: readonly SidecarStatus[] = [
  "active",
  "superseded",
  "archived",
  "deleted",
];

// Narrow parser for the positional <status> argument. Returns the validated
// enum value, or null for anything else. Intentionally case-sensitive so
// `DELETED` vs `deleted` surface as a clear rejection rather than silently
// coercing.
export function parseSidecarStatus(raw: string): SidecarStatus | null {
  const trimmed = raw.trim();
  return (SIDECAR_STATUS_VALUES as readonly string[]).includes(trimmed)
    ? (trimmed as SidecarStatus)
    : null;
}

export type SidecarStatsSummary = {
  total: number;
  pinned: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  schemaVersion: number | null;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  newestAccessedAt: number | null;
};

export type SidecarListRow = {
  refId: string;
  source: string;
  path: string;
  startLine: number;
  endLine: number;
  status: string;
  pinned: boolean;
  salience: number | null;
  createdAt: number;
};

export type SidecarListOptions = {
  status?: string;
  limit?: number;
};

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 1000;

// Counts rows by status and source plus the time bounds the operator most
// wants after flipping memoryV2.ingest.enabled on. Every query is a single
// indexed SELECT; schema-missing is not handled here because callers must
// open via openSidecarDatabase (which runs ensureSidecarSchema first).
export function readSidecarStats(db: DatabaseSync): SidecarStatsSummary {
  const totalRow = db.prepare("SELECT COUNT(*) AS n FROM memory_v2_records").get() as { n: number };
  const pinnedRow = db
    .prepare("SELECT COUNT(*) AS n FROM memory_v2_records WHERE pinned = 1")
    .get() as { n: number };
  const byStatusRows = db
    .prepare("SELECT status, COUNT(*) AS n FROM memory_v2_records GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const bySourceRows = db
    .prepare("SELECT source, COUNT(*) AS n FROM memory_v2_records GROUP BY source")
    .all() as Array<{ source: string; n: number }>;
  const bounds = db
    .prepare(
      "SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest, MAX(last_accessed_at) AS accessed FROM memory_v2_records",
    )
    .get() as { oldest: number | null; newest: number | null; accessed: number | null };
  const schemaRow = db
    .prepare("SELECT value FROM meta WHERE key = 'memory_v2_schema_version'")
    .get() as { value: string } | undefined;

  return {
    total: totalRow.n,
    pinned: pinnedRow.n,
    byStatus: Object.fromEntries(byStatusRows.map((r) => [r.status, r.n])),
    bySource: Object.fromEntries(bySourceRows.map((r) => [r.source, r.n])),
    schemaVersion: schemaRow ? parseSchemaVersion(schemaRow.value) : null,
    oldestCreatedAt: bounds.oldest,
    newestCreatedAt: bounds.newest,
    newestAccessedAt: bounds.accessed,
  };
}

export function readSidecarList(db: DatabaseSync, opts: SidecarListOptions = {}): SidecarListRow[] {
  const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, opts.limit ?? DEFAULT_LIST_LIMIT));
  const where = opts.status ? " WHERE status = ?" : "";
  const sql = `SELECT ref_id, source, path, start_line, end_line, status, pinned, salience, created_at
               FROM memory_v2_records${where}
               ORDER BY created_at DESC LIMIT ?`;
  const params: (string | number)[] = opts.status ? [opts.status, limit] : [limit];
  const rows = db.prepare(sql).all(...params) as Array<{
    ref_id: string;
    source: string;
    path: string;
    start_line: number;
    end_line: number;
    status: string;
    pinned: number;
    salience: number | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    refId: r.ref_id,
    source: r.source,
    path: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    status: r.status,
    pinned: r.pinned !== 0,
    salience: r.salience,
    createdAt: r.created_at,
  }));
}

export function formatStatsLines(stats: SidecarStatsSummary): string[] {
  const lines: string[] = [];
  lines.push(`total rows:        ${stats.total}`);
  lines.push(`pinned:            ${stats.pinned}`);
  lines.push(`schema version:    ${stats.schemaVersion ?? "n/a"}`);
  const statusKeys = Object.keys(stats.byStatus).toSorted();
  if (statusKeys.length > 0) {
    lines.push("by status:");
    for (const k of statusKeys) {
      lines.push(`  ${k.padEnd(14)} ${stats.byStatus[k]}`);
    }
  }
  const sourceKeys = Object.keys(stats.bySource).toSorted();
  if (sourceKeys.length > 0) {
    lines.push("by source:");
    for (const k of sourceKeys) {
      lines.push(`  ${k.padEnd(14)} ${stats.bySource[k]}`);
    }
  }
  lines.push(`oldest created:    ${formatTs(stats.oldestCreatedAt)}`);
  lines.push(`newest created:    ${formatTs(stats.newestCreatedAt)}`);
  lines.push(`last accessed:     ${formatTs(stats.newestAccessedAt)}`);
  return lines;
}

export function formatListLines(rows: readonly SidecarListRow[]): string[] {
  if (rows.length === 0) {
    return ["(no rows)"];
  }
  return rows.map((r) => {
    const refPrefix = r.refId.slice(0, 8);
    const location = `${r.path}:${r.startLine}-${r.endLine}`;
    const pin = r.pinned ? "pinned" : "-";
    const sal = r.salience === null ? "-" : r.salience.toFixed(2);
    return `${refPrefix}  ${r.source.padEnd(8)} ${location.padEnd(40)} ${r.status.padEnd(11)} ${pin.padEnd(6)} sal=${sal}  ${formatTs(r.createdAt)}`;
  });
}

export type SidecarPinOutcome = {
  refId: string;
  found: boolean;
  pinned: boolean;
};

// Admin-level pin/unpin by full ref id. No prefix matching in this slice —
// callers must pass a full ref id (use `memory sidecar list --json` to get
// one). `found` is false when no row matches the ref id; in that case the
// UPDATE is a no-op and `pinned` echoes the requested target value purely
// for log-line symmetry.
export function writeSidecarPin(
  db: DatabaseSync,
  refId: string,
  pinned: boolean,
): SidecarPinOutcome {
  const found = setPinned(db, refId, pinned);
  return { refId, found, pinned };
}

export function formatPinLine(outcome: SidecarPinOutcome): string {
  if (!outcome.found) {
    return `ref-id not found: ${outcome.refId}`;
  }
  return `${outcome.pinned ? "pinned" : "unpinned"} ${outcome.refId}`;
}

export type SidecarStatusOutcome = {
  refId: string;
  found: boolean;
  status: SidecarStatus;
};

// Admin-level status write by full ref id. Reuses the existing markStatus
// primitive, which is a raw UPDATE with no transition gating (deleted →
// active is allowed; trust the operator). Caller must validate the status
// string up front via parseSidecarStatus. Returns found=false when no row
// matches — the UPDATE is a no-op.
export function writeSidecarStatus(
  db: DatabaseSync,
  refId: string,
  status: SidecarStatus,
): SidecarStatusOutcome {
  const found = markStatus(db, refId, status);
  return { refId, found, status };
}

export function formatStatusLine(outcome: SidecarStatusOutcome): string {
  if (!outcome.found) {
    return `ref-id not found: ${outcome.refId}`;
  }
  return `status=${outcome.status} ${outcome.refId}`;
}

// Discriminated union so callers cannot conflate "set to zero" with "clear
// to NULL" — the two have distinct meanings in the sidecar and the rerank
// scoring path must keep them distinct.
export type SidecarSalienceArg = { kind: "set"; value: number } | { kind: "clear" };

// Returns null for anything that is neither a finite number nor the literal
// `clear` sentinel. Empty-after-trim is rejected explicitly so `Number("")`
// (which returns 0) cannot sneak through as a silent zero-salience write.
// No range gating — any finite number is accepted.
export function parseSidecarSalienceArg(raw: string): SidecarSalienceArg | null {
  const trimmed = raw.trim();
  if (trimmed === "clear") {
    return { kind: "clear" };
  }
  if (trimmed.length === 0) {
    return null;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return null;
  }
  return { kind: "set", value: n };
}

export type SidecarSalienceOutcome = {
  refId: string;
  found: boolean;
  salience: number | null;
};

// Admin-level salience write by full ref id. `salience` is a finite number
// for a set, or `null` to clear. Reuses the existing setSalience repo
// primitive; no range gating (trust the operator — same posture as the
// status writer's no-transition-gating).
export function writeSidecarSalience(
  db: DatabaseSync,
  refId: string,
  salience: number | null,
): SidecarSalienceOutcome {
  const found = setSalience(db, refId, salience);
  return { refId, found, salience };
}

export function formatSalienceLine(outcome: SidecarSalienceOutcome): string {
  if (!outcome.found) {
    return `ref-id not found: ${outcome.refId}`;
  }
  if (outcome.salience === null) {
    return `salience=clear ${outcome.refId}`;
  }
  return `salience=${outcome.salience} ${outcome.refId}`;
}

function formatTs(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) {
    return "-";
  }
  return new Date(ts).toISOString();
}

function parseSchemaVersion(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
