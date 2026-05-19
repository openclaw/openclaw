#!/usr/bin/env node
/**
 * session-consolidate.js — Stop Hook
 *
 * Claude Code 設定（.claude/settings.json）：
 * {
 *   "hooks": {
 *     "Stop": [{ "command": "node /path/to/session-consolidate.js" }]
 *   }
 * }
 *
 * stdin 接收 JSON：
 * { session_id, transcript_path, stop_reason, total_cost_usd }
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { randomUUID } = require("node:crypto");
const path = require("node:path");

/**
 * 從 stdin 讀取所有資料，回傳字串
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  const raw = await readStdin();

  /** @type {{ session_id?: string, transcript_path?: string, stop_reason?: string, total_cost_usd?: number }} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 非 JSON 輸入，靜默退出
    process.exit(0);
  }

  const stateDir =
    process.env["NUWA_STATE_DIR"] ?? path.join(process.cwd(), ".claude", "evolution-state");

  try {
    /** @type {import("better-sqlite3")} */
    const Database = require("better-sqlite3");
    const dbPath = path.join(stateDir, "nuwa.db");

    const db = new Database(dbPath, { readonly: false, fileMustExist: true });
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 3000");

    const now = new Date().toISOString();
    const sessionId = data.session_id ?? "unknown";
    const stopReason = data.stop_reason ?? "正常結束";
    const totalCost = data.total_cost_usd ?? 0;

    const summary = `[Stop hook] 對話結束。原因：${stopReason}。費用：$${totalCost}`;

    // 寫入 conversations 表
    db.prepare(
      `INSERT OR IGNORE INTO conversations
         (id, session_id, summary, participants, topic, started_at, ended_at, role_assignments, dialogue_mode)
       VALUES (?, ?, ?, ?, NULL, ?, ?, '{}', 'normal')`,
    ).run(randomUUID(), sessionId, summary, JSON.stringify(["claude", "user"]), now, now);

    // 同時記錄學習事件
    const eventPayload = JSON.stringify({
      session_id: sessionId,
      stop_reason: stopReason,
      total_cost_usd: totalCost,
    });

    db.prepare(
      `INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
       VALUES (?, NULL, 'session_end', ?, 'stop_hook', ?)`,
    ).run(randomUUID(), eventPayload, now);

    db.close();
  } catch {
    // DB 不存在或其他錯誤，靜默退出
  }

  process.exit(0);
}

void main();
