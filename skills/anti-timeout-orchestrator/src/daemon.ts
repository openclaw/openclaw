import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createDefaultDeps } from "../../../src/cli/deps.js";
import { agentCommand } from "../../../src/commands/agent.js";
import { defaultRuntime } from "../../../src/runtime.js";

const DEFAULT_QUEUE_DIR = "/home/node/.openclaw/workspace/queues/anti-timeout-orchestrator";
const DB_PATH = path.join(DEFAULT_QUEUE_DIR, "queue.sqlite3");
const POLL_INTERVAL_MS = 1000;
const WORKER_ID = `worker-node-${process.pid}`;

if (!fs.existsSync(DEFAULT_QUEUE_DIR)) {
  fs.mkdirSync(DEFAULT_QUEUE_DIR, { recursive: true });
}

interface Task {
  id: string;
  created_at: string;
  label: string;
  session: string;
  priority: number;
  timeout_s: number;
  command: string;
  reply_to: string | null;
  chat_id: string | null;
  notes: string;
  status: string;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  worker_pid: string | null;
  error: string | null;
}

function getDb(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

function recoverStaleTasks(db: DatabaseSync) {
  console.log(`[${new Date().toISOString()}] Worker ${WORKER_ID} started.`);
}

function claimTask(db: DatabaseSync): Task | undefined {
  const now = new Date().toISOString();

  const row = db.prepare(`
    SELECT * FROM tasks 
    WHERE status='pending' 
    ORDER BY priority ASC, created_at ASC, id ASC 
    LIMIT 1
  `).get() as Task | undefined;

  if (!row) return undefined;

  const info = db.prepare(`
    UPDATE tasks
    SET status='running', started_at=?, worker_pid=?, attempt=attempt+1, error=NULL
    WHERE id=? AND status='pending'
  `).run(now, WORKER_ID, row.id);

  if (info.changes !== 1) return undefined;

  return row;
}

function completeTask(
  db: DatabaseSync,
  id: string,
  status: "done" | "failed",
  error: string | null,
) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks
    SET status=?, finished_at=?, error=?
    WHERE id=?
  `).run(status, now, error, id);
}

async function runAgentTask(task: Task) {
  console.log(`[${new Date().toISOString()}] Processing task ${task.id}: ${task.label}`);

  try {
    const args = task.command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const messageIdx = args.indexOf("--message");
    const sessionIdx = args.indexOf("--session");

    let message = "";
    if (messageIdx !== -1 && messageIdx + 1 < args.length) {
      message = args[messageIdx + 1].replace(/^"|"$/g, "");
    }

    let sessionKey = "";
    if (sessionIdx !== -1 && sessionIdx + 1 < args.length) {
      sessionKey = args[sessionIdx + 1].replace(/^"|"$/g, "");
    }

    if (!message) {
      throw new Error("Could not parse --message from command");
    }

    await agentCommand(
      {
        message: message,
        sessionKey: sessionKey || undefined,
        verbose: "off",
      },
      defaultRuntime,
      createDefaultDeps(),
    );

    return { status: "done", error: null };
  } catch (err: any) {
    console.error(`[${new Date().toISOString()}] Task ${task.id} failed:`, err);
    return { status: "failed", error: err.message };
  }
}

async function main() {
  const db = getDb();
  recoverStaleTasks(db);

  console.log(`[${new Date().toISOString()}] Worker loop started.`);

  while (true) {
    try {
      const task = claimTask(db);
      if (task) {
        const result = await runAgentTask(task);
        completeTask(db, task.id, result.status as "done" | "failed", result.error);
      } else {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error("Worker loop error:", err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal worker error:", err);
    process.exit(1);
  });
}
