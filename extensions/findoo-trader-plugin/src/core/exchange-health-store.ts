/**
 * SQLite-backed store for exchange health/connectivity status.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ExchangeHealth {
  exchangeId: string;
  exchangeName: string;
  connected: boolean;
  lastPingMs: number;
  apiCallsToday: number;
  apiLimit: number;
  lastCheckAt: number | null;
  errorMessage: string | null;
  consecutiveFailures: number;
}

export class ExchangeHealthStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exchange_health (
        exchange_id TEXT PRIMARY KEY,
        exchange_name TEXT NOT NULL,
        connected INTEGER DEFAULT 0,
        last_ping_ms INTEGER DEFAULT 0,
        api_calls_today INTEGER DEFAULT 0,
        api_limit INTEGER DEFAULT 1200,
        last_check_at INTEGER,
        error_message TEXT,
        consecutive_failures INTEGER DEFAULT 0
      )
    `);
  }

  upsert(health: ExchangeHealth): void {
    const stmt = this.db.prepare(`
      INSERT INTO exchange_health (exchange_id, exchange_name, connected, last_ping_ms, api_calls_today, api_limit, last_check_at, error_message, consecutive_failures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange_id) DO UPDATE SET
        exchange_name = excluded.exchange_name,
        connected = excluded.connected,
        last_ping_ms = excluded.last_ping_ms,
        api_calls_today = excluded.api_calls_today,
        api_limit = excluded.api_limit,
        last_check_at = excluded.last_check_at,
        error_message = excluded.error_message,
        consecutive_failures = excluded.consecutive_failures
    `);
    stmt.run(
      health.exchangeId,
      health.exchangeName,
      health.connected ? 1 : 0,
      health.lastPingMs,
      health.apiCallsToday,
      health.apiLimit,
      health.lastCheckAt,
      health.errorMessage,
      health.consecutiveFailures,
    );
  }

  get(exchangeId: string): ExchangeHealth | null {
    const stmt = this.db.prepare("SELECT * FROM exchange_health WHERE exchange_id = ?");
    const row = stmt.get(exchangeId) as Record<string, unknown> | undefined;
    return row ? this.rowToHealth(row) : null;
  }

  listAll(): ExchangeHealth[] {
    const stmt = this.db.prepare("SELECT * FROM exchange_health ORDER BY exchange_id");
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToHealth(r));
  }

  recordPing(exchangeId: string, latencyMs: number): void {
    const stmt = this.db.prepare(`
      UPDATE exchange_health SET
        connected = 1,
        last_ping_ms = ?,
        last_check_at = ?,
        error_message = NULL,
        consecutive_failures = 0,
        api_calls_today = api_calls_today + 1
      WHERE exchange_id = ?
    `);
    stmt.run(latencyMs, Date.now(), exchangeId);
  }

  recordError(exchangeId: string, message: string): void {
    const stmt = this.db.prepare(`
      UPDATE exchange_health SET
        connected = 0,
        last_check_at = ?,
        error_message = ?,
        consecutive_failures = consecutive_failures + 1
      WHERE exchange_id = ?
    `);
    stmt.run(Date.now(), message, exchangeId);
  }

  resetDailyCounters(): void {
    this.db.exec("UPDATE exchange_health SET api_calls_today = 0");
  }

  close(): void {
    this.db.close();
  }

  private rowToHealth(row: Record<string, unknown>): ExchangeHealth {
    return {
      exchangeId: row.exchange_id as string,
      exchangeName: row.exchange_name as string,
      connected: (row.connected as number) === 1,
      lastPingMs: (row.last_ping_ms as number) ?? 0,
      apiCallsToday: (row.api_calls_today as number) ?? 0,
      apiLimit: (row.api_limit as number) ?? 1200,
      lastCheckAt: (row.last_check_at as number | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      consecutiveFailures: (row.consecutive_failures as number) ?? 0,
    };
  }
}
