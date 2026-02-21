import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { CoinEvent } from "./types";
import { LIMITS } from "./types";

/**
 * Validate and resolve the database path.
 * Must be within the OpenClaw data directory or /tmp.
 */
function validateDbPath(dbPath: string, baseDir: string): string {
  const resolved = path.resolve(baseDir, dbPath);
  const normalizedBase = path.resolve(baseDir);
  const normalizedTmp = path.resolve("/tmp");

  if (!resolved.startsWith(normalizedBase) && !resolved.startsWith(normalizedTmp)) {
    throw new Error(
      `Database path must be within the OpenClaw data directory or /tmp. Got: ${resolved}`
    );
  }

  if (!resolved.endsWith(".db") && !resolved.endsWith(".sqlite")) {
    throw new Error(`Database path must end with .db or .sqlite. Got: ${resolved}`);
  }

  // Ensure parent directory exists
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  return resolved;
}

export class TransactionStore {
  private db: Database.Database;

  constructor(dbPath: string, baseDir?: string) {
    const resolvedPath = baseDir ? validateDbPath(dbPath, baseDir) : dbPath;
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        coin_id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        amount INTEGER NOT NULL,
        amount_xch REAL NOT NULL,
        memo_hex TEXT,
        memo_decoded TEXT,
        is_cat INTEGER NOT NULL DEFAULT 0,
        asset_id TEXT,
        created_height INTEGER NOT NULL,
        spent_height INTEGER,
        network TEXT NOT NULL,
        matched_handler TEXT,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tx_address ON transactions(address);
      CREATE INDEX IF NOT EXISTS idx_tx_network ON transactions(network);
      CREATE INDEX IF NOT EXISTS idx_tx_created_height ON transactions(created_height);
      CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp);

      CREATE TABLE IF NOT EXISTS watched_wallets (
        address TEXT PRIMARY KEY,
        label TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  saveCoinEvent(event: CoinEvent): void {
    // Enforce row limit — prune oldest if at capacity
    this.pruneIfNeeded();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO transactions
        (coin_id, address, amount, amount_xch, memo_hex, memo_decoded, is_cat, asset_id, created_height, spent_height, network, matched_handler, timestamp)
      VALUES
        (@coinId, @address, @amount, @amountXch, @memoHex, @memoDecoded, @isCat, @assetId, @createdHeight, @spentHeight, @network, @matchedHandler, @timestamp)
    `);
    stmt.run({
      coinId: event.coinId,
      address: event.address,
      amount: event.amount,
      amountXch: event.amountXch,
      memoHex: event.memoHex,
      memoDecoded: event.memoDecoded,
      isCat: event.isCat ? 1 : 0,
      assetId: event.assetId ?? null,
      createdHeight: event.createdHeight,
      spentHeight: event.spentHeight,
      network: event.network,
      matchedHandler: event.matchedHandler ?? null,
      timestamp: event.timestamp,
    });
  }

  private pruneIfNeeded(): void {
    const count = (this.db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c;
    if (count >= LIMITS.MAX_DB_ROWS) {
      this.db.prepare(
        `DELETE FROM transactions WHERE coin_id IN (
          SELECT coin_id FROM transactions ORDER BY created_height ASC LIMIT ?
        )`
      ).run(LIMITS.DB_PRUNE_BATCH);
    }
  }

  getRecentTransactions(limit = 50): CoinEvent[] {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    return this.db
      .prepare("SELECT * FROM transactions ORDER BY created_height DESC LIMIT ?")
      .all(safeLimit) as CoinEvent[];
  }

  getTransactionsByAddress(address: string, limit = 50): CoinEvent[] {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    return this.db
      .prepare("SELECT * FROM transactions WHERE address = ? ORDER BY created_height DESC LIMIT ?")
      .all(address, safeLimit) as CoinEvent[];
  }

  saveState(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)").run(key, value);
  }

  getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  addWallet(address: string, label?: string): void {
    // Enforce wallet limit
    const count = (this.db.prepare("SELECT COUNT(*) as c FROM watched_wallets WHERE active = 1").get() as any).c;
    if (count >= LIMITS.MAX_WALLETS) {
      throw new Error(`Maximum wallet limit (${LIMITS.MAX_WALLETS}) reached`);
    }
    this.db.prepare("INSERT OR REPLACE INTO watched_wallets (address, label, active) VALUES (?, ?, 1)").run(address, label ?? null);
  }

  removeWallet(address: string): void {
    this.db.prepare("UPDATE watched_wallets SET active = 0 WHERE address = ?").run(address);
  }

  getActiveWallets(): { address: string; label: string | null }[] {
    return this.db.prepare("SELECT address, label FROM watched_wallets WHERE active = 1").all() as any[];
  }

  getStats(): { totalTx: number; uniqueAddresses: number; latestHeight: number | null } {
    const totalTx = (this.db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c;
    const uniqueAddresses = (this.db.prepare("SELECT COUNT(DISTINCT address) as c FROM transactions").get() as any).c;
    const latestHeight = (this.db.prepare("SELECT MAX(created_height) as h FROM transactions").get() as any).h;
    return { totalTx, uniqueAddresses, latestHeight };
  }

  close(): void {
    this.db.close();
  }
}
