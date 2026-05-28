#!/usr/bin/env node
/**
 * post-cron-learner.js — Cron 執行後學習橋接
 *
 * 讀取最新的 cron 報告，寫入 nuwa.db learning_events。
 * 可獨立執行：node post-cron-learner.js [report-json-path]
 * 也可被 openclaw-cron-direct-runner.mjs import 呼叫。
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const fs = require("node:fs");
const SCRIPT_FILE_PATH = path.resolve(fileURLToPath(import.meta.url));

const DEFAULT_REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-cron-direct-runner-latest.json",
);

const DEFAULT_DB_PATH = path.join(
  process.cwd(),
  "extensions",
  "evolution-learning",
  ".claude",
  "evolution-state",
  "nuwa.db",
);

/**
 * @param {{ reportPath?: string, dbPath?: string, reportData?: object }} opts
 */
export function ingestCronReport(opts = {}) {
  const dbPath =
    opts.dbPath ??
    (process.env["NUWA_STATE_DIR"]
      ? path.join(process.env["NUWA_STATE_DIR"], "nuwa.db")
      : DEFAULT_DB_PATH);

  let report = opts.reportData;
  if (!report) {
    const reportPath = opts.reportPath ?? DEFAULT_REPORT_PATH;
    if (!fs.existsSync(reportPath)) {
      return { ok: false, reason: "report not found" };
    }
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  }

  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: "nuwa.db not found" };
  }

  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: false, fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");

  const payload = JSON.stringify({
    job_type: report.schema ?? "unknown",
    task_id: report.task?.id ?? "unknown",
    exit_code: report.task?.exitCode ?? -1,
    duration_ms: report.task?.durationMs ?? 0,
    core_result: report.core_result ?? "unknown",
    lane: report.lane ?? null,
    blockers: report.remaining_blockers ?? [],
    stdout_tail: (report.stdout_tail ?? "").slice(0, 300),
  });

  db.prepare(
    `INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
     VALUES (?, NULL, 'cron_run', ?, 'post_cron_hook', ?)`,
  ).run(randomUUID(), payload, new Date().toISOString());

  db.close();
  return { ok: true, taskId: report.task?.id };
}

async function main() {
  const reportPath = process.argv[2] ?? DEFAULT_REPORT_PATH;
  try {
    const result = ingestCronReport({ reportPath });
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error("post-cron-learner error:", err.message);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE_PATH) {
  void main();
}
