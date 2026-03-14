/**
 * SQLite-backed task persistence for Findoo Alpha.
 *
 * Stores task→thread mapping so in-flight analyses survive gateway restarts.
 * LangGraph threads are server-side persistent — we only need to remember
 * which tasks were running and their thread IDs for recovery polling.
 *
 * Uses `node:sqlite` (Node 22+ built-in, DatabaseSync) — same pattern as
 * findoo-trader-plugin's AgentEventSqliteStore.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TaskRow = {
  taskId: string;
  threadId: string;
  sessionKey: string;
  label: string;
  query: string;
  status: "running" | "completed" | "failed" | "lost";
  submittedAt: number;
  completedAt: number | null;
  error: string | null;
  retries: number;
};

export class TaskStore {
  private db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alpha_tasks (
        task_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        label TEXT NOT NULL,
        query TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        submitted_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        retries INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_alpha_tasks_status ON alpha_tasks (status)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_alpha_tasks_submitted ON alpha_tasks (submitted_at DESC)",
    );
  }

  /** Whether the database has been closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Insert a new running task. */
  insert(task: {
    taskId: string;
    threadId: string;
    sessionKey: string;
    label: string;
    query: string;
    submittedAt: number;
  }): void {
    if (this.closed) return;
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO alpha_tasks (task_id, thread_id, session_key, label, query, status, submitted_at, retries) VALUES (?, ?, ?, ?, ?, 'running', ?, 0)",
    );
    stmt.run(task.taskId, task.threadId, task.sessionKey, task.label, task.query, task.submittedAt);
  }

  /** Update task status. */
  updateStatus(
    taskId: string,
    status: "completed" | "failed" | "lost",
    opts?: { completedAt?: number; error?: string },
  ): void {
    if (this.closed) return;
    const stmt = this.db.prepare(
      "UPDATE alpha_tasks SET status = ?, completed_at = ?, error = ? WHERE task_id = ?",
    );
    stmt.run(status, opts?.completedAt ?? Date.now(), opts?.error ?? null, taskId);
  }

  /** Increment retry counter. Returns the new value. */
  incrementRetries(taskId: string): number {
    if (this.closed) return 0;
    this.db.prepare("UPDATE alpha_tasks SET retries = retries + 1 WHERE task_id = ?").run(taskId);
    const row = this.db.prepare("SELECT retries FROM alpha_tasks WHERE task_id = ?").get(taskId) as
      | { retries: number }
      | undefined;
    return row?.retries ?? 0;
  }

  /** Find all tasks with status='running'. */
  findRunning(): TaskRow[] {
    const rows = this.db
      .prepare(
        "SELECT task_id, thread_id, session_key, label, query, status, submitted_at, completed_at, error, retries FROM alpha_tasks WHERE status = 'running' ORDER BY submitted_at ASC",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(toTaskRow);
  }

  /** Find a single task by ID. */
  findByTaskId(taskId: string): TaskRow | null {
    const row = this.db
      .prepare(
        "SELECT task_id, thread_id, session_key, label, query, status, submitted_at, completed_at, error, retries FROM alpha_tasks WHERE task_id = ?",
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? toTaskRow(row) : null;
  }

  /** Delete completed/failed/lost tasks older than maxAgeMs. */
  cleanup(maxAgeMs: number): void {
    if (this.closed) return;
    const cutoff = Date.now() - maxAgeMs;
    this.db
      .prepare(
        "DELETE FROM alpha_tasks WHERE status IN ('completed', 'failed', 'lost') AND submitted_at < ?",
      )
      .run(cutoff);
  }

  /** Close the database. Safe to call multiple times. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function toTaskRow(row: Record<string, unknown>): TaskRow {
  return {
    taskId: row.task_id as string,
    threadId: row.thread_id as string,
    sessionKey: row.session_key as string,
    label: row.label as string,
    query: row.query as string,
    status: row.status as TaskRow["status"],
    submittedAt: row.submitted_at as number,
    completedAt: (row.completed_at as number) ?? null,
    error: (row.error as string) ?? null,
    retries: row.retries as number,
  };
}
