import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OHLCV } from "./types.js";

export class OHLCVCache {
  private db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ohlcv (
        symbol TEXT NOT NULL,
        market TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        PRIMARY KEY (symbol, market, timeframe, timestamp)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ohlcv_lookup
      ON ohlcv (symbol, market, timeframe, timestamp)
    `);
  }

  upsertBatch(symbol: string, market: string, timeframe: string, rows: OHLCV[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ohlcv (symbol, market, timeframe, timestamp, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      stmt.run(
        symbol,
        market,
        timeframe,
        row.timestamp,
        row.open,
        row.high,
        row.low,
        row.close,
        row.volume,
      );
    }
  }

  query(
    symbol: string,
    market: string,
    timeframe: string,
    since?: number,
    until?: number,
  ): OHLCV[] {
    let sql =
      "SELECT timestamp, open, high, low, close, volume FROM ohlcv WHERE symbol = ? AND market = ? AND timeframe = ?";
    const params: (string | number)[] = [symbol, market, timeframe];

    if (since != null) {
      sql += " AND timestamp >= ?";
      params.push(since);
    }
    if (until != null) {
      sql += " AND timestamp <= ?";
      params.push(until);
    }
    sql += " ORDER BY timestamp ASC";

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      timestamp: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;

    return rows.map((r) => ({
      timestamp: r.timestamp,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }

  getRange(
    symbol: string,
    market: string,
    timeframe: string,
  ): { earliest: number; latest: number } | null {
    const stmt = this.db.prepare(
      "SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM ohlcv WHERE symbol = ? AND market = ? AND timeframe = ?",
    );
    const row = stmt.get(symbol, market, timeframe) as
      | { earliest: number | null; latest: number | null }
      | undefined;

    if (!row || row.earliest == null || row.latest == null) {
      return null;
    }
    return { earliest: row.earliest, latest: row.latest };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
