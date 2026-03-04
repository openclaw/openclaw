/**
 * SQLite persistence for KOL news items, subscriptions, and scan history.
 *
 * Uses Node 22 native `node:sqlite` DatabaseSync with WAL mode.
 * Pattern follows fin-monitoring/alert-store.ts and fin-paper-trading/paper-store.ts.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KolNewsItem } from "./grok-client.js";

// ── Types ────────────────────────────────────────────────────────

export type Subscription = {
  handle: string;
  priority: "low" | "medium" | "high" | "critical";
  active: boolean;
  addedAt: string;
};

export type ScanRecord = {
  id: number;
  startedAt: string;
  completedAt: string | null;
  itemsFound: number;
  status: "running" | "completed" | "failed";
  error: string | null;
};

export type NewsStats = {
  totalItems: number;
  unpushedCount: number;
  avgScore: number;
  topHandles: Array<{ handle: string; count: number }>;
};

// ── Store ────────────────────────────────────────────────────────

export class NewsStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS news_items (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        handle TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        score INTEGER NOT NULL,
        category TEXT NOT NULL,
        symbols_json TEXT NOT NULL DEFAULT '[]',
        sentiment TEXT NOT NULL DEFAULT 'neutral',
        source_urls_json TEXT NOT NULL DEFAULT '[]',
        scanned_at TEXT NOT NULL,
        pushed INTEGER NOT NULL DEFAULT 0,
        pushed_at TEXT,
        digest_included INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        handle TEXT PRIMARY KEY,
        priority TEXT NOT NULL DEFAULT 'medium',
        active INTEGER NOT NULL DEFAULT 1,
        added_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        items_found INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT
      )
    `);

    // Indexes for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_news_score ON news_items(score DESC);
      CREATE INDEX IF NOT EXISTS idx_news_pushed ON news_items(pushed, score DESC);
      CREATE INDEX IF NOT EXISTS idx_news_scanned_at ON news_items(scanned_at DESC);
    `);
  }

  // ── News Items ───────────────────────────────────────────────

  insertItems(items: KolNewsItem[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO news_items
        (id, source, handle, title, summary, score, category, symbols_json, sentiment, source_urls_json, scanned_at, pushed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    for (const item of items) {
      const result = stmt.run(
        item.id,
        item.source,
        item.handle,
        item.title,
        item.summary,
        item.score,
        item.category,
        JSON.stringify(item.symbols),
        item.sentiment,
        JSON.stringify(item.sourceUrls),
        item.scannedAt,
        item.pushed ? 1 : 0,
      );
      if (result.changes > 0) inserted++;
    }
    return inserted;
  }

  getUrgentUnpushed(threshold: number): KolNewsItem[] {
    const stmt = this.db.prepare(
      "SELECT * FROM news_items WHERE pushed = 0 AND score >= ? ORDER BY score DESC, scanned_at DESC",
    );
    const rows = stmt.all(threshold) as Array<Record<string, unknown>>;
    return rows.map(rowToNewsItem);
  }

  getItemsSince(since: string, minScore: number): KolNewsItem[] {
    const stmt = this.db.prepare(
      "SELECT * FROM news_items WHERE scanned_at >= ? AND score >= ? ORDER BY score DESC, scanned_at DESC",
    );
    const rows = stmt.all(since, minScore) as Array<Record<string, unknown>>;
    return rows.map(rowToNewsItem);
  }

  getRecent(limit: number): KolNewsItem[] {
    const stmt = this.db.prepare(
      "SELECT * FROM news_items ORDER BY scanned_at DESC LIMIT ?",
    );
    const rows = stmt.all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToNewsItem);
  }

  markPushed(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `UPDATE news_items SET pushed = 1, pushed_at = ? WHERE id IN (${placeholders})`,
    );
    stmt.run(new Date().toISOString(), ...ids);
  }

  markDigestIncluded(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `UPDATE news_items SET digest_included = 1 WHERE id IN (${placeholders})`,
    );
    stmt.run(...ids);
  }

  getStats(since: string): NewsStats {
    const countStmt = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM news_items WHERE scanned_at >= ?",
    );
    const totalRow = countStmt.get(since) as { cnt: number } | undefined;
    const totalItems = totalRow?.cnt ?? 0;

    const unpushedStmt = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM news_items WHERE pushed = 0 AND scanned_at >= ?",
    );
    const unpushedRow = unpushedStmt.get(since) as { cnt: number } | undefined;
    const unpushedCount = unpushedRow?.cnt ?? 0;

    const avgStmt = this.db.prepare(
      "SELECT AVG(score) as avg_score FROM news_items WHERE scanned_at >= ?",
    );
    const avgRow = avgStmt.get(since) as { avg_score: number | null } | undefined;
    const avgScore = Math.round((avgRow?.avg_score ?? 0) * 10) / 10;

    const handleStmt = this.db.prepare(
      "SELECT handle, COUNT(*) as cnt FROM news_items WHERE scanned_at >= ? GROUP BY handle ORDER BY cnt DESC LIMIT 10",
    );
    const handleRows = handleStmt.all(since) as Array<{ handle: string; cnt: number }>;
    const topHandles = handleRows.map((r) => ({ handle: r.handle, count: r.cnt }));

    return { totalItems, unpushedCount, avgScore, topHandles };
  }

  // ── Subscriptions ────────────────────────────────────────────

  addSubscription(handle: string, priority: Subscription["priority"] = "medium"): void {
    const stmt = this.db.prepare(`
      INSERT INTO subscriptions (handle, priority, active, added_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(handle) DO UPDATE SET priority = excluded.priority, active = 1
    `);
    stmt.run(handle.replace(/^@/, "").toLowerCase(), priority, new Date().toISOString());
  }

  removeSubscription(handle: string): void {
    const stmt = this.db.prepare("UPDATE subscriptions SET active = 0 WHERE handle = ?");
    stmt.run(handle.replace(/^@/, "").toLowerCase());
  }

  getActiveSubscriptions(): Subscription[] {
    const stmt = this.db.prepare("SELECT * FROM subscriptions WHERE active = 1 ORDER BY handle");
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      handle: row.handle as string,
      priority: row.priority as Subscription["priority"],
      active: (row.active as number) === 1,
      addedAt: row.added_at as string,
    }));
  }

  // ── Scan History ─────────────────────────────────────────────

  startScan(): number {
    const stmt = this.db.prepare(
      "INSERT INTO scan_history (started_at, status) VALUES (?, 'running')",
    );
    const result = stmt.run(new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  completeScan(scanId: number, itemsFound: number): void {
    const stmt = this.db.prepare(
      "UPDATE scan_history SET completed_at = ?, items_found = ?, status = 'completed' WHERE id = ?",
    );
    stmt.run(new Date().toISOString(), itemsFound, scanId);
  }

  failScan(scanId: number, error: string): void {
    const stmt = this.db.prepare(
      "UPDATE scan_history SET completed_at = ?, status = 'failed', error = ? WHERE id = ?",
    );
    stmt.run(new Date().toISOString(), error.slice(0, 500), scanId);
  }

  getLastScanTime(): string | null {
    const stmt = this.db.prepare(
      "SELECT completed_at FROM scan_history WHERE status = 'completed' ORDER BY id DESC LIMIT 1",
    );
    const row = stmt.get() as { completed_at: string | null } | undefined;
    return row?.completed_at ?? null;
  }

  close(): void {
    this.db.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function rowToNewsItem(row: Record<string, unknown>): KolNewsItem {
  return {
    id: row.id as string,
    source: row.source as "x_search",
    handle: row.handle as string,
    title: row.title as string,
    summary: row.summary as string,
    score: row.score as number,
    category: row.category as string,
    symbols: JSON.parse(row.symbols_json as string) as string[],
    sentiment: row.sentiment as "bullish" | "bearish" | "neutral",
    sourceUrls: JSON.parse(row.source_urls_json as string) as string[],
    scannedAt: row.scanned_at as string,
    pushed: (row.pushed as number) === 1,
  };
}
