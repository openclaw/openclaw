import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestCronReport } from "../hooks/post-cron-learner.js";

const require = createRequire(import.meta.url);

type MinimalBetterSqliteStatement = {
  get(...params: unknown[]): unknown;
};

type MinimalBetterSqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): MinimalBetterSqliteStatement;
  close(): void;
};

type BetterSqliteConstructor = new (
  filePath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => MinimalBetterSqliteDatabase;

const BetterSqlite3 = require("better-sqlite3") as BetterSqliteConstructor;
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createLearningEventsDb(dbPath: string): Promise<void> {
  const db = new BetterSqlite3(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS learning_events (
    id TEXT PRIMARY KEY,
    pattern_slug TEXT,
    event_type TEXT NOT NULL,
    payload TEXT,
    source TEXT,
    recorded_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.close();
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("post-cron-learner", () => {
  it("prefers explicit dbPath over NUWA_STATE_DIR", async () => {
    const tempDir = await createTempDir("post-cron-learner-");
    const explicitDbDir = path.join(tempDir, "explicit-db");
    const envDbDir = path.join(tempDir, "env-db");
    await fs.mkdir(explicitDbDir, { recursive: true });
    await fs.mkdir(envDbDir, { recursive: true });

    const explicitDbPath = path.join(explicitDbDir, "nuwa.db");
    await createLearningEventsDb(explicitDbPath);

    const previousNuwaStateDir = process.env.NUWA_STATE_DIR;
    process.env.NUWA_STATE_DIR = envDbDir;

    try {
      const result = ingestCronReport({
        dbPath: explicitDbPath,
        reportData: {
          schema: "openclaw.cron-direct-runner.report.v1",
          task: {
            id: "next-safe",
            exitCode: 0,
            durationMs: 1,
          },
          core_result: "success",
          stdout_tail: "ok",
        },
      });

      expect(result).toMatchObject({ ok: true, taskId: "next-safe" });

      const db = new BetterSqlite3(explicitDbPath, { readonly: true, fileMustExist: true });
      const row = db
        .prepare(
          "SELECT event_type, source, payload FROM learning_events ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { event_type: string; source: string; payload: string } | undefined;
      db.close();

      expect(row).toBeDefined();
      expect(row?.event_type).toBe("cron_run");
      expect(row?.source).toBe("post_cron_hook");

      const payload = JSON.parse(row?.payload ?? "{}") as { task_id?: string };
      expect(payload.task_id).toBe("next-safe");
    } finally {
      if (previousNuwaStateDir === undefined) {
        delete process.env.NUWA_STATE_DIR;
      } else {
        process.env.NUWA_STATE_DIR = previousNuwaStateDir;
      }
    }
  });
});
