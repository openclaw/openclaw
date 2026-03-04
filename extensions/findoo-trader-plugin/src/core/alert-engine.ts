/**
 * SQLite-backed alert engine with CRUD for price/portfolio alerts.
 * Follows the same DatabaseSync + WAL pattern as agent-event-sqlite-store.ts.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AlertEngineLike } from "../types-http.js";

type AlertCondition = {
  kind: string;
  symbol?: string;
  price?: number;
  threshold?: number;
  direction?: string;
};

type AlertRow = {
  id: string;
  condition_json: string;
  message: string | null;
  created_at: string;
  triggered_at: string | null;
  notified: number; // SQLite boolean
};

export class AlertEngine implements AlertEngineLike {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        condition_json TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        triggered_at TEXT,
        notified INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  addAlert(condition: AlertCondition, message?: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO alerts (id, condition_json, message, created_at, notified) VALUES (?, ?, ?, ?, 0)",
    );
    stmt.run(id, JSON.stringify(condition), message ?? null, now);
    return id;
  }

  removeAlert(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM alerts WHERE id = ?");
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  listAlerts(): Array<{
    id: string;
    condition: Record<string, unknown>;
    createdAt: string;
    triggeredAt?: string;
    notified: boolean;
    message?: string;
  }> {
    const stmt = this.db.prepare(
      "SELECT id, condition_json, message, created_at, triggered_at, notified FROM alerts ORDER BY created_at DESC",
    );
    const rows = stmt.all() as AlertRow[];
    return rows.map((row) => ({
      id: row.id,
      condition: JSON.parse(row.condition_json) as Record<string, unknown>,
      createdAt: row.created_at,
      ...(row.triggered_at ? { triggeredAt: row.triggered_at } : {}),
      notified: row.notified === 1,
      ...(row.message ? { message: row.message } : {}),
    }));
  }

  /** Mark an alert as triggered. */
  triggerAlert(id: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE alerts SET triggered_at = ?, notified = 1 WHERE id = ?");
    const result = stmt.run(now, id);
    return (result as { changes: number }).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
