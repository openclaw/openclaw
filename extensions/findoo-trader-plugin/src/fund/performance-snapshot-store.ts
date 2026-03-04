/**
 * SQLite-backed store for periodic performance snapshots.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface PerformanceSnapshot {
  id: string;
  period: string;
  periodType: "daily" | "weekly" | "monthly";
  totalPnl: number;
  totalReturn: number;
  sharpe: number | null;
  maxDrawdown: number | null;
  byStrategyJson: string | null;
  byMarketJson: string | null;
  bySymbolJson: string | null;
  createdAt: number;
}

export class PerformanceSnapshotStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS performance_snapshots (
        id TEXT PRIMARY KEY,
        period TEXT NOT NULL,
        period_type TEXT NOT NULL DEFAULT 'daily',
        total_pnl REAL DEFAULT 0,
        total_return REAL DEFAULT 0,
        sharpe REAL,
        max_drawdown REAL,
        by_strategy_json TEXT,
        by_market_json TEXT,
        by_symbol_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_perf_period ON performance_snapshots(period_type, period)
    `);
  }

  addSnapshot(snapshot: PerformanceSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO performance_snapshots
        (id, period, period_type, total_pnl, total_return, sharpe, max_drawdown, by_strategy_json, by_market_json, by_symbol_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      snapshot.id,
      snapshot.period,
      snapshot.periodType,
      snapshot.totalPnl,
      snapshot.totalReturn,
      snapshot.sharpe,
      snapshot.maxDrawdown,
      snapshot.byStrategyJson,
      snapshot.byMarketJson,
      snapshot.bySymbolJson,
      snapshot.createdAt,
    );
  }

  getLatest(periodType: string, limit = 30): PerformanceSnapshot[] {
    const stmt = this.db.prepare(
      "SELECT * FROM performance_snapshots WHERE period_type = ? ORDER BY created_at DESC LIMIT ?",
    );
    const rows = stmt.all(periodType, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSnapshot(r));
  }

  getByPeriod(from: number, to: number): PerformanceSnapshot[] {
    const stmt = this.db.prepare(
      "SELECT * FROM performance_snapshots WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC",
    );
    const rows = stmt.all(from, to) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSnapshot(r));
  }

  close(): void {
    this.db.close();
  }

  private rowToSnapshot(row: Record<string, unknown>): PerformanceSnapshot {
    return {
      id: row.id as string,
      period: row.period as string,
      periodType: (row.period_type as "daily" | "weekly" | "monthly") ?? "daily",
      totalPnl: (row.total_pnl as number) ?? 0,
      totalReturn: (row.total_return as number) ?? 0,
      sharpe: (row.sharpe as number | null) ?? null,
      maxDrawdown: (row.max_drawdown as number | null) ?? null,
      byStrategyJson: (row.by_strategy_json as string | null) ?? null,
      byMarketJson: (row.by_market_json as string | null) ?? null,
      bySymbolJson: (row.by_symbol_json as string | null) ?? null,
      createdAt: (row.created_at as number) ?? 0,
    };
  }
}
