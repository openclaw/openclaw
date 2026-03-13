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
    // Migration: add acknowledged, retry_count, last_retry_at columns
    this.migrateAddRetryColumns();
  }

  /** Idempotent migration: add retry/acknowledgment columns. */
  private migrateAddRetryColumns(): void {
    try {
      this.db.exec("ALTER TABLE alerts ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE alerts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE alerts ADD COLUMN last_retry_at TEXT");
    } catch {
      // Column already exists — ignore
    }
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

  /** Mark an alert as triggered (sets triggered_at but NOT notified — use acknowledgeAlert for that). */
  triggerAlert(id: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE alerts SET triggered_at = ? WHERE id = ? AND triggered_at IS NULL",
    );
    const result = stmt.run(now, id);
    return (result as { changes: number }).changes > 0;
  }

  /** Acknowledge an alert (marks notified=1 + acknowledged=1). Called after successful delivery. */
  acknowledgeAlert(id: string): boolean {
    const stmt = this.db.prepare("UPDATE alerts SET notified = 1, acknowledged = 1 WHERE id = ?");
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  /** Get triggered but unacknowledged alerts eligible for retry. */
  getUnacknowledged(maxRetries = 5): Array<{
    id: string;
    condition: AlertCondition;
    message: string | null;
    retryCount: number;
  }> {
    const stmt = this.db.prepare(
      "SELECT id, condition_json, message, retry_count FROM alerts WHERE triggered_at IS NOT NULL AND acknowledged = 0 AND retry_count < ?",
    );
    const rows = stmt.all(maxRetries) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      condition: JSON.parse(row.condition_json as string) as AlertCondition,
      message: row.message as string | null,
      retryCount: (row.retry_count as number) ?? 0,
    }));
  }

  /** Increment retry count for a failed delivery attempt. */
  incrementRetry(id: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE alerts SET retry_count = retry_count + 1, last_retry_at = ? WHERE id = ?",
    );
    stmt.run(now, id);
  }

  /** Get all active (untriggered) alerts with parsed conditions. */
  getActiveAlerts(): Array<{ id: string; condition: AlertCondition }> {
    const stmt = this.db.prepare(
      "SELECT id, condition_json FROM alerts WHERE triggered_at IS NULL",
    );
    return (stmt.all() as AlertRow[]).map((r) => ({
      id: r.id,
      condition: JSON.parse(r.condition_json) as AlertCondition,
    }));
  }

  /**
   * Check all active alerts against current prices, trigger those that match.
   * Returns IDs of newly triggered alerts.
   */
  checkAndTrigger(getPrice: (symbol: string) => number | undefined): string[] {
    const triggered: string[] = [];
    for (const alert of this.getActiveAlerts()) {
      const { kind, symbol, price: target } = alert.condition;
      if (!symbol || target == null) continue;
      const current = getPrice(symbol);
      if (current == null) continue;

      const hit =
        (kind === "price_above" && current >= target) ||
        (kind === "price_below" && current <= target);

      if (hit) {
        this.triggerAlert(alert.id);
        triggered.push(alert.id);
      }
    }
    return triggered;
  }

  close(): void {
    this.db.close();
  }
}
