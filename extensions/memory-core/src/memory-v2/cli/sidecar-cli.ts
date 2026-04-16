import type { DatabaseSync } from "node:sqlite";

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
