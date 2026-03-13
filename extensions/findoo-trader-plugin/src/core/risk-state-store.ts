/**
 * SQLite-backed persistence for RiskController daily state.
 * Ensures dailyLossUsd, paused flag, and reset date survive gateway restarts.
 * Follows the same DatabaseSync + WAL pattern as other stores.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RiskDailyState {
  date: string;
  lossUsd: number;
  paused: boolean;
  updatedAt: number;
}

export class RiskStateStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS risk_daily_state (
        date TEXT PRIMARY KEY,
        loss_usd REAL NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  /** Get today's accumulated loss. Returns null if no record exists for today. */
  getTodayLoss(): RiskDailyState | null {
    const today = new Date().toISOString().slice(0, 10);
    const stmt = this.db.prepare(
      "SELECT date, loss_usd, paused, updated_at FROM risk_daily_state WHERE date = ?",
    );
    const row = stmt.get(today) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      date: row.date as string,
      lossUsd: row.loss_usd as number,
      paused: (row.paused as number) === 1,
      updatedAt: row.updated_at as number,
    };
  }

  /** Record (upsert) the daily loss for a given date. */
  recordLoss(date: string, lossUsd: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO risk_daily_state (date, loss_usd, paused, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(date) DO UPDATE SET
        loss_usd = ?,
        updated_at = ?
    `);
    const now = Date.now();
    stmt.run(date, lossUsd, now, lossUsd, now);
  }

  /** Persist the paused flag (writes to today's row). */
  setPaused(paused: boolean): void {
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO risk_daily_state (date, loss_usd, paused, updated_at)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        paused = ?,
        updated_at = ?
    `);
    stmt.run(today, paused ? 1 : 0, now, paused ? 1 : 0, now);
  }

  /** Get the persisted paused flag from the most recent row. */
  getPaused(): boolean {
    const stmt = this.db.prepare("SELECT paused FROM risk_daily_state ORDER BY date DESC LIMIT 1");
    const row = stmt.get() as { paused: number } | undefined;
    return row ? row.paused === 1 : false;
  }

  close(): void {
    this.db.close();
  }
}
