/**
 * SQLite-backed agent activity audit log.
 * Tracks all lifecycle actions (promotions, demotions, wake events, approvals, etc.)
 * for the Flow dashboard timeline and debugging.
 *
 * Pattern mirrors AgentEventSqliteStore: SQLite persistence + in-memory cache + subscriber push.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ── Types ──────────────────────────────────────────────────────────

export type ActivityCategory =
  | "wake"
  | "promotion"
  | "demotion"
  | "approval"
  | "decision"
  | "error"
  | "heartbeat"
  | "seed"
  | "ideation";

export interface ActivityEntry {
  id: string;
  timestamp: number;
  category: ActivityCategory;
  action: string;
  strategyId?: string;
  detail: string;
  metadata?: Record<string, unknown>;
}

export type ActivitySubscriber = (entry: ActivityEntry) => void;

// ── Store ──────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;

export class ActivityLogStore {
  private db: DatabaseSync;
  private entries: ActivityEntry[] = [];
  private subscribers = new Set<ActivitySubscriber>();
  private counter = 0;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
    this.loadFromDisk();
  }

  // ── Schema ─────────────────────────────────────────────────────

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_activity_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        strategy_id TEXT,
        detail TEXT NOT NULL,
        metadata_json TEXT
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_activity_category ON agent_activity_log (category)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_activity_ts ON agent_activity_log (timestamp DESC)",
    );
  }

  // ── Load ───────────────────────────────────────────────────────

  private loadFromDisk(): void {
    const stmt = this.db.prepare(
      "SELECT id, timestamp, category, action, strategy_id, detail, metadata_json FROM agent_activity_log ORDER BY timestamp DESC, rowid DESC LIMIT ?",
    );
    const rows = stmt.all(MAX_ENTRIES) as Array<Record<string, unknown>>;

    this.entries = rows.reverse().map((row) => {
      const entry: ActivityEntry = {
        id: row.id as string,
        timestamp: row.timestamp as number,
        category: row.category as ActivityCategory,
        action: row.action as string,
        detail: row.detail as string,
      };
      if (row.strategy_id != null) entry.strategyId = row.strategy_id as string;
      if (row.metadata_json != null) {
        entry.metadata = JSON.parse(row.metadata_json as string) as Record<string, unknown>;
      }
      return entry;
    });

    // Restore counter from highest numeric portion ("act-N-xxx").
    let maxNum = 0;
    for (const e of this.entries) {
      const match = /^act-(\d+)-/.exec(e.id);
      if (match) {
        const num = Number.parseInt(match[1]!, 10);
        if (num > maxNum) maxNum = num;
      }
    }
    this.counter = maxNum;
  }

  // ── Write ──────────────────────────────────────────────────────

  /** Append a new activity entry, persist, and notify subscribers. */
  append(input: Omit<ActivityEntry, "id" | "timestamp"> & { timestamp?: number }): ActivityEntry {
    const entry: ActivityEntry = {
      ...input,
      id: `act-${++this.counter}-${Date.now().toString(36)}`,
      timestamp: input.timestamp ?? Date.now(),
    };

    const stmt = this.db.prepare(
      "INSERT INTO agent_activity_log (id, timestamp, category, action, strategy_id, detail, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    stmt.run(
      entry.id,
      entry.timestamp,
      entry.category,
      entry.action,
      entry.strategyId ?? null,
      entry.detail,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );

    this.entries.push(entry);
    this.trimEntries();

    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch {
        // Subscriber errors should not break the store.
      }
    }

    return entry;
  }

  // ── Read ───────────────────────────────────────────────────────

  /** List recent entries, newest first. Optionally filter by category. */
  listRecent(limit = 50, category?: ActivityCategory): ActivityEntry[] {
    let result = [...this.entries];
    if (category) {
      result = result.filter((e) => e.category === category);
    }
    return result.reverse().slice(0, limit);
  }

  /** Get a single entry by ID. */
  get(id: string): ActivityEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  // ── Subscribe ──────────────────────────────────────────────────

  /** Subscribe to new activity entries. Returns unsubscribe function. */
  subscribe(callback: ActivitySubscriber): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  private trimEntries(): void {
    if (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      const deleteStmt = this.db.prepare("DELETE FROM agent_activity_log WHERE id = ?");
      for (const e of removed) {
        deleteStmt.run(e.id);
      }
    }
  }
}
