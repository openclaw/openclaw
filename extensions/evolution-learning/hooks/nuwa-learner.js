#!/usr/bin/env node
/**
 * nuwa-learner.js — PostToolUse Hook
 *
 * Claude Code 設定（.claude/settings.json）：
 * {
 *   "hooks": {
 *     "PostToolUse": [{ "command": "node /path/to/nuwa-learner.js" }]
 *   }
 * }
 *
 * stdin 接收 JSON：
 * { tool_name, tool_input, tool_response, session_id, cost_usd }
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

  /** @type {{ tool_name?: string, tool_input?: Record<string, unknown>, tool_response?: unknown, session_id?: string, cost_usd?: number }} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 非 JSON 輸入，靜默退出不中斷主流程
    process.exit(0);
  }

  const stateDir =
    process.env["NUWA_STATE_DIR"] ?? path.join(process.cwd(), ".claude", "evolution-state");

  try {
    // 延遲 require，DB 不存在時才靜默退出
    /** @type {import("better-sqlite3")} */
    const Database = require("better-sqlite3");
    const dbPath = path.join(stateDir, "nuwa.db");

    const db = new Database(dbPath, { readonly: false, fileMustExist: true });
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 3000");

    const toolInputKeys = data.tool_input ? Object.keys(data.tool_input) : [];
    const costUsd = typeof data.cost_usd === "number" ? data.cost_usd : 0;

    const payload = JSON.stringify({
      tool_name: data.tool_name ?? "unknown",
      tool_input_keys: toolInputKeys,
      cost_usd: costUsd,
    });

    db.prepare(
      `INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
       VALUES (?, NULL, 'tool_use', ?, 'post_tool_use_hook', ?)`,
    ).run(randomUUID(), payload, new Date().toISOString());

    db.close();
  } catch {
    // DB 不存在（migrate 尚未執行）或其他錯誤，靜默退出
  }

  process.exit(0);
}

void main();
