/**
 * SQLite-backed task queue.
 * Router pushes tasks, agents pull and execute them.
 */

import Database from "better-sqlite3";
import type { Task, AgentId, TaskStatus, Classification, Route } from "../types.js";

export class TaskQueue {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        agent TEXT NOT NULL,
        classification TEXT NOT NULL,
        route TEXT NOT NULL,
        input TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        session_key TEXT,
        result TEXT,
        error TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
    `);
  }

  /**
   * Push a new task into the queue.
   */
  push(task: Task): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, created_at, status, agent, classification, route, input, channel_id, session_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      task.id,
      task.createdAt,
      task.status,
      task.agent,
      JSON.stringify(task.classification),
      JSON.stringify(task.route),
      task.input,
      task.channelId,
      task.sessionKey ?? null,
    );
  }

  /**
   * Pull the next pending task for a specific agent.
   */
  pull(agent: AgentId): Task | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE agent = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
      )
      .get(agent) as any;

    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * Pull all pending tasks for an agent.
   */
  pullAll(agent: AgentId): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE agent = ? AND status = 'pending' ORDER BY created_at ASC`,
      )
      .all(agent) as any[];

    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Update task status.
   */
  updateStatus(
    taskId: string,
    status: TaskStatus,
    result?: string,
    error?: string,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = ?, result = ?, error = ?, completed_at = ?
      WHERE id = ?
    `);
    const completedAt =
      status === "done" || status === "failed"
        ? new Date().toISOString()
        : null;
    stmt.run(status, result ?? null, error ?? null, completedAt, taskId);
  }

  /**
   * Get a task by ID.
   */
  get(taskId: string): Task | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) as any;
    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * Get recent tasks (for dashboard/monitoring).
   */
  recent(limit: number = 20): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Get task counts by status.
   */
  counts(): Record<TaskStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts as Record<TaskStatus, number>;
  }

  close(): void {
    this.db.close();
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      createdAt: row.created_at,
      status: row.status as TaskStatus,
      agent: row.agent as AgentId,
      classification: JSON.parse(row.classification) as Classification,
      route: JSON.parse(row.route) as Route,
      input: row.input,
      channelId: row.channel_id,
      sessionKey: row.session_key ?? undefined,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      completedAt: row.completed_at ?? undefined,
    };
  }
}
