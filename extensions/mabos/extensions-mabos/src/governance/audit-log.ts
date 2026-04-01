/**
 * Append-only audit log backed by SQLite.
 */

import Database from "better-sqlite3";
import type { AuditEntry } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  company_id TEXT NOT NULL DEFAULT 'default',
  actor_type TEXT NOT NULL CHECK(actor_type IN ('agent', 'operator', 'system', 'hook')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  detail TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'denied', 'error', 'pending'))
);

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
`;

interface LogParams {
  companyId?: string;
  actorType: AuditEntry["actorType"];
  actorId: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  detail?: string | null;
  outcome: AuditEntry["outcome"];
}

interface QueryParams {
  companyId?: string;
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export class AuditLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /**
   * Append an audit entry.
   */
  log(params: LogParams): number {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (company_id, actor_type, actor_id, action, resource_type, resource_id, detail, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      params.companyId ?? "default",
      params.actorType,
      params.actorId,
      params.action,
      params.resourceType ?? null,
      params.resourceId ?? null,
      params.detail ?? null,
      params.outcome,
    );
    return result.lastInsertRowid as number;
  }

  /**
   * Query audit entries with optional filters.
   */
  query(params: QueryParams = {}): AuditEntry[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.companyId) {
      conditions.push("company_id = ?");
      values.push(params.companyId);
    }
    if (params.action) {
      conditions.push("action = ?");
      values.push(params.action);
    }
    if (params.actorId) {
      conditions.push("actor_id = ?");
      values.push(params.actorId);
    }
    if (params.from) {
      conditions.push("timestamp >= ?");
      values.push(params.from);
    }
    if (params.to) {
      conditions.push("timestamp <= ?");
      values.push(params.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;

    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as Record<string, unknown>[];

    return rows.map((row) => this.rowToEntry(row));
  }

  close(): void {
    this.db.close();
  }

  private rowToEntry(row: Record<string, unknown>): AuditEntry {
    return {
      id: row.id as number,
      timestamp: row.timestamp as string,
      companyId: row.company_id as string,
      actorType: row.actor_type as AuditEntry["actorType"],
      actorId: row.actor_id as string,
      action: row.action as string,
      resourceType: (row.resource_type as string) ?? null,
      resourceId: (row.resource_id as string) ?? null,
      detail: (row.detail as string) ?? null,
      outcome: row.outcome as AuditEntry["outcome"],
    };
  }
}
