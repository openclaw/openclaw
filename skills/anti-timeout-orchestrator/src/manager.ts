import { DatabaseSync } from "node:sqlite";
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_QUEUE_DIR = "/home/node/.openclaw/workspace/queues/anti-timeout-orchestrator";
const DB_PATH = path.join(DEFAULT_QUEUE_DIR, "queue.sqlite3");
const POLL_INTERVAL_MS = 200;
const WORKER_SCRIPT = path.join(__dirname, "worker.ts");

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

let warmWorker: ChildProcess | null = null;
let warmWorkerReady = false;

function getDb(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

function spawnWorker() {
  const worker = fork(WORKER_SCRIPT, [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, OPENCLAW_WORKER: "1" },
  });

  worker.on("message", (msg: any) => {
    if (msg.type === "ready") {
      console.log(`[Manager] Worker ${worker.pid} is ready.`);
      if (worker === warmWorker) {
        warmWorkerReady = true;
      }
    }
  });

  worker.on("exit", (code) => {
    console.log(`[Manager] Worker ${worker.pid} exited with code ${code}.`);
    if (worker === warmWorker) {
      warmWorker = null;
      warmWorkerReady = false;
      if (code !== 0) {
        console.log("[Manager] Warm worker died unexpectedly. Respawning...");
        ensureWarmWorker();
      }
    }
  });

  return worker;
}

function ensureWarmWorker() {
  if (!warmWorker || warmWorker.killed) {
    console.log("[Manager] Spawning new warm worker...");
    warmWorker = spawnWorker();
    warmWorkerReady = false;
  }
}

function recoverStaleTasks(db: DatabaseSync) {
  const info = db.prepare(`
    UPDATE tasks 
    SET status = 'pending', worker_pid = NULL, started_at = NULL 
    WHERE status = 'running'
  `).run();

  if (info.changes > 0) {
    console.log(`[Manager] Recovered ${info.changes} stale tasks.`);
  }
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
    SET status='running', started_at=?, attempt=attempt+1, error=NULL
    WHERE id=? AND status='pending'
  `).run(now, row.id);

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

async function main() {
  const db = getDb();
  recoverStaleTasks(db);

  console.log(`[Manager] Starting Prefork Manager (PID ${process.pid})...`);
  ensureWarmWorker();

  while (true) {
    try {
      if (!warmWorker || !warmWorkerReady) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const task = claimTask(db);
      if (task) {
        console.log(
          `[Manager] Claimed task ${task.id}. Dispatching to worker ${warmWorker.pid}...`,
        );

        const activeWorker = warmWorker;
        activeWorker.send({ type: "execute", task });

        warmWorker = null;
        warmWorkerReady = false;

        ensureWarmWorker();

        activeWorker.on("message", (msg: any) => {
          if (msg.type === "result") {
            console.log(`[Manager] Task ${msg.taskId} finished: ${msg.status}`);
            completeTask(db, msg.taskId, msg.status, msg.error);
          }
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error("[Manager] Loop error:", err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal manager error:", err);
    process.exit(1);
  });
}
