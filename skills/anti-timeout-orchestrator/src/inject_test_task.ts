import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_QUEUE_DIR = "/home/node/.openclaw/workspace/queues/anti-timeout-orchestrator";
const DB_PATH = path.join(DEFAULT_QUEUE_DIR, "queue.sqlite3");

if (!fs.existsSync(DEFAULT_QUEUE_DIR)) {
  fs.mkdirSync(DEFAULT_QUEUE_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    created_at TEXT,
    label TEXT,
    session TEXT,
    priority INTEGER,
    timeout_s INTEGER,
    command TEXT,
    reply_to TEXT,
    chat_id TEXT,
    notes TEXT,
    status TEXT,
    attempt INTEGER,
    started_at TEXT,
    finished_at TEXT,
    worker_pid TEXT,
    error TEXT
  )
`);

const taskId = `test-task-${Date.now()}`;
const command =
  'openclaw agent --session "agent:main:test" --message "Hello from prefork worker verification"';

console.log(`Injecting task ${taskId}...`);

db.prepare(`
  INSERT INTO tasks (
    id, created_at, label, session, priority, timeout_s, command, status, attempt
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`).run(
  taskId,
  new Date().toISOString(),
  "Test Task",
  "agent:main:test",
  10,
  60,
  command,
  "pending",
  0,
);

console.log("Task injected.");
