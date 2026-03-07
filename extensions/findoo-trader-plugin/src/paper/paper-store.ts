import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PaperAccountState, PaperOrder, PaperPosition, EquitySnapshot } from "./types.js";

export class PaperStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        initial_capital REAL NOT NULL,
        cash REAL NOT NULL,
        positions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        quantity REAL NOT NULL,
        limit_price REAL,
        fill_price REAL,
        commission REAL,
        slippage REAL,
        status TEXT NOT NULL,
        reason TEXT,
        strategy_id TEXT,
        created_at INTEGER NOT NULL,
        filled_at INTEGER
      )
    `);

    // Migration: add market column to orders table
    try {
      this.db.exec("ALTER TABLE orders ADD COLUMN market TEXT");
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS equity_snapshots (
        account_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        equity REAL NOT NULL,
        cash REAL NOT NULL,
        positions_value REAL NOT NULL,
        daily_pnl REAL NOT NULL,
        daily_pnl_pct REAL NOT NULL,
        PRIMARY KEY (account_id, timestamp)
      )
    `);
  }

  saveAccount(state: PaperAccountState): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO accounts (id, name, initial_capital, cash, positions_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      state.id,
      state.name,
      state.initialCapital,
      state.cash,
      JSON.stringify(state.positions),
      state.createdAt,
      state.updatedAt,
    );
  }

  loadAccount(id: string): PaperAccountState | null {
    const stmt = this.db.prepare("SELECT * FROM accounts WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const positions = JSON.parse(row.positions_json as string) as PaperPosition[];
    const orders = this.getOrders(id);

    let equity = row.cash as number;
    for (const pos of positions) {
      equity += pos.currentPrice * pos.quantity;
    }

    return {
      id: row.id as string,
      name: row.name as string,
      initialCapital: row.initial_capital as number,
      cash: row.cash as number,
      equity,
      positions,
      orders,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  listAccounts(): Array<{ id: string; name: string; equity: number; updatedAt: number }> {
    const stmt = this.db.prepare(
      "SELECT id, name, cash, positions_json, updated_at FROM accounts ORDER BY updated_at DESC",
    );
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const positions = JSON.parse(row.positions_json as string) as PaperPosition[];
      let equity = row.cash as number;
      for (const pos of positions) {
        equity += pos.currentPrice * pos.quantity;
      }
      return {
        id: row.id as string,
        name: row.name as string,
        equity,
        updatedAt: row.updated_at as number,
      };
    });
  }

  saveOrder(order: PaperOrder): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO orders
        (id, account_id, symbol, side, type, quantity, limit_price, fill_price, commission, slippage, status, reason, strategy_id, created_at, filled_at, market)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      order.id,
      order.accountId,
      order.symbol,
      order.side,
      order.type,
      order.quantity,
      order.limitPrice ?? null,
      order.fillPrice ?? null,
      order.commission ?? null,
      order.slippage ?? null,
      order.status,
      order.reason ?? null,
      order.strategyId ?? null,
      order.createdAt,
      order.filledAt ?? null,
      order.market ?? null,
    );
  }

  getOrders(accountId: string, limit?: number): PaperOrder[] {
    const sql = limit
      ? "SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC";

    const stmt = this.db.prepare(sql);
    const rows = (limit ? stmt.all(accountId, limit) : stmt.all(accountId)) as Array<
      Record<string, unknown>
    >;

    return rows.map((row) => ({
      id: row.id as string,
      accountId: row.account_id as string,
      symbol: row.symbol as string,
      side: row.side as "buy" | "sell",
      type: row.type as "market" | "limit",
      quantity: row.quantity as number,
      limitPrice: row.limit_price as number | undefined,
      fillPrice: row.fill_price as number | undefined,
      commission: row.commission as number | undefined,
      slippage: row.slippage as number | undefined,
      status: row.status as PaperOrder["status"],
      reason: row.reason as string | undefined,
      strategyId: row.strategy_id as string | undefined,
      createdAt: row.created_at as number,
      filledAt: row.filled_at as number | undefined,
      market: (row.market as string | undefined) ?? undefined,
    }));
  }

  saveSnapshot(snapshot: EquitySnapshot): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO equity_snapshots
        (account_id, timestamp, equity, cash, positions_value, daily_pnl, daily_pnl_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      snapshot.accountId,
      snapshot.timestamp,
      snapshot.equity,
      snapshot.cash,
      snapshot.positionsValue,
      snapshot.dailyPnl,
      snapshot.dailyPnlPct,
    );
  }

  getSnapshots(accountId: string, since?: number): EquitySnapshot[] {
    const sql = since
      ? "SELECT * FROM equity_snapshots WHERE account_id = ? AND timestamp >= ? ORDER BY timestamp ASC"
      : "SELECT * FROM equity_snapshots WHERE account_id = ? ORDER BY timestamp ASC";

    const stmt = this.db.prepare(sql);
    const rows = (since ? stmt.all(accountId, since) : stmt.all(accountId)) as Array<
      Record<string, unknown>
    >;

    return rows.map((row) => ({
      accountId: row.account_id as string,
      timestamp: row.timestamp as number,
      equity: row.equity as number,
      cash: row.cash as number,
      positionsValue: row.positions_value as number,
      dailyPnl: row.daily_pnl as number,
      dailyPnlPct: row.daily_pnl_pct as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}
