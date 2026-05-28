#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./lib/sqlite-compat.mjs";

const SCRIPT_FILE_PATH = path.resolve(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_FILE_PATH), "..");
const STATE_DIR = path.join(REPO_ROOT, "reports", "hermes-agent", "state");
const NUWA_DB_PATH = path.join(
  REPO_ROOT,
  "extensions",
  "evolution-learning",
  ".claude",
  "evolution-state",
  "nuwa.db",
);
const LEARNING_HOOK_MODULE = "../extensions/evolution-learning/hooks/post-cron-learner.js";
const REPORT_SCHEMA = "openclaw.cron-direct-runner.report.v1";

const TASK_MAP = {
  "next-safe": "autonomous:controlled:next-safe",
  "openclaw-d-big-repair-check": "autonomous:controlled:run --task openclaw-d-big-repair-check",
  "trading-paper-hft-trigger": "autonomous:controlled:run --task trading-paper-hft-trigger",
  "learning-daily-check": "autonomous:learning:report:daily-check",
  "test-changed-closure": "autonomous:test:changed:closure",
  "inventory-check": "autonomous:inventory:check",
  "dmad-health": "dmad:health",
  "dmad-smoke-test": "dmad:smoke-test",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { task: null, report: false, learn: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && args[i + 1]) {
      opts.task = args[++i];
    } else if (args[i] === "--report") {
      opts.report = true;
    } else if (args[i] === "--learn") {
      opts.learn = true;
    } else if (args[i] === "--dry-run") {
      opts.dryRun = true;
    }
  }
  return opts;
}

function runTask(command, dryRun) {
  const parts = command.split(/\s+/);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  if (dryRun) {
    return {
      stdout: `[dry-run] would execute: pnpm ${command}`,
      stderr: "",
      exitCode: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
    };
  }

  try {
    const stdout = execFileSync("pnpm", parts, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      stdout: stdout.slice(-2000),
      stderr: "",
      exitCode: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      stdout: (err.stdout ?? "").slice(-2000),
      stderr: (err.stderr ?? "").slice(-1000),
      exitCode: err.status ?? 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
    };
  }
}

function buildReport(taskId, command, result) {
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    task: {
      id: taskId,
      command: `pnpm ${command}`,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
    },
    core_result: result.exitCode === 0 ? "success" : "failed",
    stdout_tail: result.stdout.slice(-500),
    stderr_tail: result.stderr.slice(-300),
  };
}

function writeReport(report) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tsFile = path.join(STATE_DIR, `openclaw-cron-direct-runner-${Date.now()}.json`);
  const latestFile = path.join(STATE_DIR, "openclaw-cron-direct-runner-latest.json");
  const json = JSON.stringify(report, null, 2);
  fs.writeFileSync(tsFile, json);
  fs.writeFileSync(latestFile, json);
  return { tsFile, latestFile };
}

export async function writeToNuwaDb(report, options = {}) {
  const dbPath = options.dbPath ?? NUWA_DB_PATH;
  const hookImporter = options.hookImporter ?? ((specifier) => import(specifier));
  const openDbFn = options.openDbFn ?? openDb;
  const fileSystem = options.fileSystem ?? fs;
  const createId = options.createId ?? randomUUID;

  try {
    const hookModule = await hookImporter(LEARNING_HOOK_MODULE);
    if (typeof hookModule.ingestCronReport === "function") {
      const result = await hookModule.ingestCronReport({
        reportData: report,
        dbPath,
      });
      if (result?.ok === true) {
        return true;
      }
    }
  } catch {
    // Fall through to local write path.
  }

  try {
    if (!fileSystem.existsSync(dbPath)) {
      return false;
    }
    const db = await openDbFn(dbPath, { readonly: false, fileMustExist: true });
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 3000");

    db.prepare(`CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY,
      pattern_slug TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      source TEXT,
      recorded_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();

    const payload = JSON.stringify({
      job_type: "cron_direct_run",
      task_id: report.task.id,
      exit_code: report.task.exitCode,
      duration_ms: report.task.durationMs,
      core_result: report.core_result,
      stdout_tail: report.stdout_tail,
    });

    db.prepare(
      `INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
       VALUES (?, NULL, 'cron_run', ?, 'post_cron_hook', ?)`,
    ).run(createId(), payload, new Date().toISOString());

    db.close();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs();
  if (!opts.task) {
    console.error(
      "Usage: openclaw-cron-direct-runner.mjs --task <task-id> [--report] [--learn] [--dry-run]",
    );
    console.error("Available tasks:", Object.keys(TASK_MAP).join(", "));
    process.exit(1);
  }

  const taskId = opts.task;
  if (!Object.hasOwn(TASK_MAP, taskId)) {
    console.error("Unknown task:", taskId);
    console.error("Available tasks:", Object.keys(TASK_MAP).join(", "));
    process.exit(1);
  }

  const command = TASK_MAP[taskId];
  const result = runTask(command, opts.dryRun);
  const report = buildReport(taskId, command, result);

  if (opts.report) {
    const files = writeReport(report);
    console.error(`Report written: ${files.latestFile}`);
  }

  if (opts.learn) {
    const ok = await writeToNuwaDb(report);
    console.error(
      ok ? "Learning event written to nuwa.db" : "Learning event skipped (nuwa.db unavailable)",
    );
  }

  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = result.exitCode === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE_PATH) {
  void main();
}
