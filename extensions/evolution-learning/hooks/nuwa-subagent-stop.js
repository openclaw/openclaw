#!/usr/bin/env node
/**
 * nuwa-subagent-stop.js — SubagentStop Hook
 *
 * Claude Code 設定（.claude/settings.json）：
 * {
 *   "hooks": {
 *     "SubagentStop": [{ "command": "node /path/to/nuwa-subagent-stop.js" }]
 *   }
 * }
 *
 * stdin 接收 JSON：
 * { session_id, subagent_id, stop_reason, total_cost_usd, tool_uses }
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

  /** @type {{ session_id?: string, subagent_id?: string, stop_reason?: string, total_cost_usd?: number, tool_uses?: unknown[] }} */
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
    /** @type {import("better-sqlite3")} */
    const Database = require("better-sqlite3");
    const dbPath = path.join(stateDir, "nuwa.db");

    const db = new Database(dbPath, { readonly: false, fileMustExist: true });
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 3000");

    const now = new Date().toISOString();
    const subagentId = data.subagent_id ?? "unknown";
    const stopReason = data.stop_reason ?? "unknown";
    const costUsd = typeof data.total_cost_usd === "number" ? data.total_cost_usd : 0;
    const toolUseCount = Array.isArray(data.tool_uses) ? data.tool_uses.length : 0;

    // 記錄 subagent_stop 事件
    const payload = JSON.stringify({
      subagent_id: subagentId,
      stop_reason: stopReason,
      cost_usd: costUsd,
      tool_use_count: toolUseCount,
    });

    db.prepare(
      `INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
       VALUES (?, NULL, 'subagent_stop', ?, 'subagent_stop_hook', ?)`,
    ).run(randomUUID(), payload, now);

    // 高費用子代理警示（> $0.1）
    if (costUsd > 0.1) {
      const alertPayload = JSON.stringify({
        subagent_id: subagentId,
        cost_usd: costUsd,
        stop_reason: stopReason,
      });
      db.prepare(
        `INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
         VALUES (?, NULL, 'high_cost_subagent_alert', ?, 'subagent_stop_hook', ?)`,
      ).run(randomUUID(), alertPayload, now);
    }

    db.close();
  } catch {
    // DB 不存在（migrate 尚未執行）或其他錯誤，靜默退出
  }

  process.exit(0);
}

void main();
