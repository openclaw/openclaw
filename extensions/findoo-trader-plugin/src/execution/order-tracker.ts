/**
 * SQLite-backed order tracker for live execution.
 * Implements write-ahead logging: orders are recorded as SUBMITTED before
 * being sent to the exchange, then updated to FILLED/FAILED/CANCELLED.
 * This ensures in-flight orders are visible after gateway restarts.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OrderStatus = "SUBMITTED" | "FILLED" | "PARTIALLY_FILLED" | "FAILED" | "CANCELLED";

export interface TrackedOrder {
  id: string;
  exchangeId: string;
  exchangeOrderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  price: number | null;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export class OrderTracker {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_orders (
        id TEXT PRIMARY KEY,
        exchange_id TEXT NOT NULL,
        exchange_order_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        price REAL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tracked_status ON tracked_orders (status)");
  }

  /** Record a new order as SUBMITTED (write-ahead, before exchange call). */
  recordSubmitted(params: {
    exchangeId: string;
    symbol: string;
    side: "buy" | "sell";
    type: "market" | "limit";
    amount: number;
    price?: number;
  }): string {
    const id = randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO tracked_orders (id, exchange_id, exchange_order_id, symbol, side, type, amount, price, status, created_at, updated_at, error)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, NULL)
    `);
    stmt.run(
      id,
      params.exchangeId,
      params.symbol,
      params.side,
      params.type,
      params.amount,
      params.price ?? null,
      now,
      now,
    );
    return id;
  }

  /** Update order status after exchange response. */
  updateStatus(id: string, status: OrderStatus, exchangeOrderId?: string, error?: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE tracked_orders SET
        status = ?,
        exchange_order_id = COALESCE(?, exchange_order_id),
        error = ?,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, exchangeOrderId ?? null, error ?? null, now, id);
  }

  /** Get all orders still in SUBMITTED state (in-flight). */
  getSubmitted(): TrackedOrder[] {
    const stmt = this.db.prepare(
      "SELECT * FROM tracked_orders WHERE status = 'SUBMITTED' ORDER BY created_at ASC",
    );
    return (stmt.all() as Array<Record<string, unknown>>).map((r) => this.rowToOrder(r));
  }

  /** Get recent orders (any status), newest first. */
  getRecent(limit = 50): TrackedOrder[] {
    const stmt = this.db.prepare("SELECT * FROM tracked_orders ORDER BY created_at DESC LIMIT ?");
    return (stmt.all(limit) as Array<Record<string, unknown>>).map((r) => this.rowToOrder(r));
  }

  close(): void {
    this.db.close();
  }

  private rowToOrder(row: Record<string, unknown>): TrackedOrder {
    return {
      id: row.id as string,
      exchangeId: row.exchange_id as string,
      exchangeOrderId: (row.exchange_order_id as string | null) ?? null,
      symbol: row.symbol as string,
      side: row.side as "buy" | "sell",
      type: row.type as "market" | "limit",
      amount: row.amount as number,
      price: (row.price as number | null) ?? null,
      status: row.status as OrderStatus,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      error: (row.error as string | null) ?? null,
    };
  }
}
