/**
 * SQLite-backed store for capital flow records (deposits, withdrawals, transfers).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CapitalFlow {
  id: string;
  type: "deposit" | "withdrawal" | "transfer" | "fee" | "rebate";
  amount: number;
  currency: string;
  status: "completed" | "pending" | "failed";
  description: string | null;
  createdAt: number;
}

export class CapitalFlowStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capital_flows (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        status TEXT DEFAULT 'completed',
        description TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_flows_time ON capital_flows(created_at DESC)
    `);
  }

  record(flow: CapitalFlow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO capital_flows (id, type, amount, currency, status, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      flow.id,
      flow.type,
      flow.amount,
      flow.currency,
      flow.status,
      flow.description,
      flow.createdAt,
    );
  }

  list(limit = 50, offset = 0): CapitalFlow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM capital_flows ORDER BY created_at DESC LIMIT ? OFFSET ?",
    );
    const rows = stmt.all(limit, offset) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToFlow(r));
  }

  getByDateRange(from: number, to: number): CapitalFlow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM capital_flows WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(from, to) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToFlow(r));
  }

  totalByType(type: string): number {
    const stmt = this.db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM capital_flows WHERE type = ?",
    );
    const row = stmt.get(type) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  close(): void {
    this.db.close();
  }

  private rowToFlow(row: Record<string, unknown>): CapitalFlow {
    return {
      id: row.id as string,
      type: row.type as CapitalFlow["type"],
      amount: (row.amount as number) ?? 0,
      currency: (row.currency as string) ?? "USD",
      status: (row.status as CapitalFlow["status"]) ?? "completed",
      description: (row.description as string | null) ?? null,
      createdAt: (row.created_at as number) ?? 0,
    };
  }
}
