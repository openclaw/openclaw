/**
 * SQLite-backed store for agent events with SSE subscriber support.
 * Drop-in replacement for the in-memory AgentEventStore with persistence.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentEvent,
  AgentEventStatus,
  AgentEventType,
  EventSubscriber,
} from "./agent-event-store.js";

export type {
  AgentEvent,
  AgentEventType,
  AgentEventStatus,
  EventSubscriber,
} from "./agent-event-store.js";

const MAX_EVENTS = 500;

export class AgentEventSqliteStore {
  private db: DatabaseSync;
  private events: AgentEvent[] = [];
  private subscribers = new Set<EventSubscriber>();
  private counter = 0;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
    this.loadFromDisk();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL,
        action_params_json TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_status ON agent_events (status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_ts ON agent_events (timestamp DESC)");
  }

  /** Load the most recent MAX_EVENTS rows into memory and restore the counter. */
  private loadFromDisk(): void {
    const stmt = this.db.prepare(
      "SELECT id, type, title, detail, timestamp, status, action_params_json FROM agent_events ORDER BY timestamp DESC, rowid DESC LIMIT ?",
    );
    const rows = stmt.all(MAX_EVENTS) as Array<Record<string, unknown>>;

    // Rows come newest-first; reverse so events array is chronological (oldest first).
    this.events = rows.reverse().map((row) => {
      const event: AgentEvent = {
        id: row.id as string,
        type: row.type as AgentEventType,
        title: row.title as string,
        detail: row.detail as string,
        timestamp: row.timestamp as number,
        status: row.status as AgentEventStatus,
      };
      if (row.action_params_json != null) {
        event.actionParams = JSON.parse(row.action_params_json as string) as Record<
          string,
          unknown
        >;
      }
      return event;
    });

    // Restore counter from the highest numeric portion of existing IDs ("evt-N-xxx").
    let maxNum = 0;
    for (const evt of this.events) {
      const match = /^evt-(\d+)-/.exec(evt.id);
      if (match) {
        const num = Number.parseInt(match[1]!, 10);
        if (num > maxNum) maxNum = num;
      }
    }
    this.counter = maxNum;
  }

  /** Add an event and notify all subscribers. */
  addEvent(input: Omit<AgentEvent, "id" | "timestamp"> & { timestamp?: number }): AgentEvent {
    const event: AgentEvent = {
      ...input,
      id: `evt-${++this.counter}-${Date.now().toString(36)}`,
      timestamp: input.timestamp ?? Date.now(),
    };

    // Persist to SQLite.
    const stmt = this.db.prepare(
      "INSERT INTO agent_events (id, type, title, detail, timestamp, status, action_params_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    stmt.run(
      event.id,
      event.type,
      event.title,
      event.detail,
      event.timestamp,
      event.status,
      event.actionParams ? JSON.stringify(event.actionParams) : null,
    );

    this.events.push(event);
    this.trimEvents();

    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // Subscriber errors should not break the store.
      }
    }

    return event;
  }

  /** List events, optionally filtered by type. Newest first. */
  listEvents(filter?: { type?: AgentEventType; status?: AgentEventStatus }): AgentEvent[] {
    let result = [...this.events];
    if (filter?.type) {
      result = result.filter((e) => e.type === filter.type);
    }
    if (filter?.status) {
      result = result.filter((e) => e.status === filter.status);
    }
    return result.reverse();
  }

  /** Get a single event by ID. */
  getEvent(id: string): AgentEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Approve a pending event. Returns the updated event or undefined if not found. */
  approve(id: string): AgentEvent | undefined {
    const event = this.events.find((e) => e.id === id);
    if (!event || event.status !== "pending") return undefined;
    event.status = "approved";

    // Persist status change.
    const updateStmt = this.db.prepare("UPDATE agent_events SET status = ? WHERE id = ?");
    updateStmt.run("approved", id);

    const notification: AgentEvent = {
      ...event,
      id: `evt-${++this.counter}-${Date.now().toString(36)}`,
      type: "system",
      title: `Approved: ${event.title}`,
      detail: `Action approved by user`,
      timestamp: Date.now(),
      status: "completed",
    };

    // Persist notification.
    const insertStmt = this.db.prepare(
      "INSERT INTO agent_events (id, type, title, detail, timestamp, status, action_params_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertStmt.run(
      notification.id,
      notification.type,
      notification.title,
      notification.detail,
      notification.timestamp,
      notification.status,
      notification.actionParams ? JSON.stringify(notification.actionParams) : null,
    );

    this.events.push(notification);

    for (const sub of this.subscribers) {
      try {
        sub(notification);
      } catch {}
    }

    return event;
  }

  /** Reject a pending event. Returns the updated event or undefined if not found. */
  reject(id: string, reason?: string): AgentEvent | undefined {
    const event = this.events.find((e) => e.id === id);
    if (!event || event.status !== "pending") return undefined;
    event.status = "rejected";

    // Persist status change.
    const updateStmt = this.db.prepare("UPDATE agent_events SET status = ? WHERE id = ?");
    updateStmt.run("rejected", id);

    const notification: AgentEvent = {
      ...event,
      id: `evt-${++this.counter}-${Date.now().toString(36)}`,
      type: "system",
      title: `Rejected: ${event.title}`,
      detail: reason ?? "Action rejected by user",
      timestamp: Date.now(),
      status: "completed",
    };

    // Persist notification.
    const insertStmt = this.db.prepare(
      "INSERT INTO agent_events (id, type, title, detail, timestamp, status, action_params_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertStmt.run(
      notification.id,
      notification.type,
      notification.title,
      notification.detail,
      notification.timestamp,
      notification.status,
      notification.actionParams ? JSON.stringify(notification.actionParams) : null,
    );

    this.events.push(notification);

    for (const sub of this.subscribers) {
      try {
        sub(notification);
      } catch {}
    }

    return event;
  }

  /** Subscribe to new events. Returns an unsubscribe function. */
  subscribe(callback: EventSubscriber): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /** Get the count of pending events. */
  pendingCount(): number {
    return this.events.filter((e) => e.status === "pending").length;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /** Trim in-memory array and purge old rows from disk when over MAX_EVENTS. */
  private trimEvents(): void {
    if (this.events.length > MAX_EVENTS) {
      const removed = this.events.splice(0, this.events.length - MAX_EVENTS);
      // Delete the evicted rows from SQLite.
      const deleteStmt = this.db.prepare("DELETE FROM agent_events WHERE id = ?");
      for (const evt of removed) {
        deleteStmt.run(evt.id);
      }
    }
  }
}
