#!/usr/bin/env node
/**
 * database-poll-bridge.mjs — 数据库增量轮询连接器
 *
 * 环境变量：
 *   CW_DB_URL            数据库连接串 (postgresql://... | sqlite:... | file:...)
 *   CW_DB_TABLE          要轮询的表名（默认 events）
 *   CW_DB_TIMESTAMP_COL  时间戳列名（默认 updated_at）
 *   CW_DB_ID_COL         主键列名（默认 id）
 *   CW_DB_POLL_MS        轮询间隔毫秒（默认 30000）
 *   CW_DB_EVENT_TYPE     发布的事件类型（默认 database.record_changed）
 *   CW_DB_BATCH_SIZE     每批最大行数（默认 100）
 *
 * NDJSON 输出格式（到 stdout）：
 *   { "type": "event", "event": "database.record_changed", "payload": { "table": "...", "rows": [...], "count": N } }
 *   { "type": "ready" }
 *   { "type": "error", "message": "..." }
 *
 * stdin 接受：
 *   { "type": "ping" }  → 输出 { "type": "pong" }
 *   { "type": "reset" } → 重置游标（从头轮询）
 */

import { createInterface } from "node:readline";

const DB_URL = process.env.CW_DB_URL;
const TABLE = process.env.CW_DB_TABLE || "events";
const TS_COL = process.env.CW_DB_TIMESTAMP_COL || "updated_at";
const ID_COL = process.env.CW_DB_ID_COL || "id";
const POLL_MS = parseInt(process.env.CW_DB_POLL_MS || "30000", 10);
const EVENT_TYPE = process.env.CW_DB_EVENT_TYPE || "database.record_changed";
const BATCH_SIZE = parseInt(process.env.CW_DB_BATCH_SIZE || "100", 10);

/** @param {unknown} obj */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * 创建数据库客户端
 * @param {string | undefined} url
 * @returns {Promise<{ type: string; db?: import("better-sqlite3").Database; pool?: import("pg").Pool; reason?: string }>}
 */
async function createDbClient(url) {
  if (!url) {
    return { type: "demo", reason: "CW_DB_URL not set" };
  }
  if (url.startsWith("sqlite:") || url.startsWith("file:")) {
    try {
      const { default: Database } = await import("better-sqlite3");
      const path = url
        .replace(/^sqlite:\/\/\//, "/")
        .replace(/^sqlite:\/\//, "")
        .replace(/^sqlite:/, "")
        .replace(/^file:/, "");
      const db = new Database(path, { readonly: true });
      return { type: "sqlite", db };
    } catch {
      return { type: "demo", reason: "better-sqlite3 not available" };
    }
  }
  if (url.startsWith("postgresql:") || url.startsWith("postgres:")) {
    try {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: url });
      return { type: "pg", pool };
    } catch {
      return { type: "demo", reason: "pg not available" };
    }
  }
  return { type: "demo", reason: `unsupported db url scheme: ${url.split(":")[0]}` };
}

/**
 * @param {{ type: string; db?: import("better-sqlite3").Database; pool?: import("pg").Pool }} client
 * @param {string | null} lastSeenAt
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function queryNew(client, lastSeenAt) {
  if (client.type === "demo") {
    // 演示模式：约 1/3 概率生成一条模拟记录
    if (Math.random() >= 0.33) return [];
    return [
      {
        [ID_COL]: `demo-${Date.now()}`,
        [TS_COL]: new Date().toISOString(),
        data: "demo record",
        _demo: true,
      },
    ];
  }

  const sinceIso = lastSeenAt ? new Date(lastSeenAt).toISOString() : new Date(0).toISOString();

  if (client.type === "sqlite" && client.db) {
    const stmt = client.db.prepare(
      `SELECT * FROM "${TABLE}" WHERE "${TS_COL}" > ? ORDER BY "${TS_COL}" ASC, "${ID_COL}" ASC LIMIT ?`,
    );
    return /** @type {Record<string, unknown>[]} */ (stmt.all(sinceIso, BATCH_SIZE));
  }

  if (client.type === "pg" && client.pool) {
    const res = await client.pool.query(
      `SELECT * FROM "${TABLE}" WHERE "${TS_COL}" > $1 ORDER BY "${TS_COL}" ASC, "${ID_COL}" ASC LIMIT $2`,
      [sinceIso, BATCH_SIZE],
    );
    return res.rows;
  }

  return [];
}

async function main() {
  const client = await createDbClient(DB_URL);
  emit({ type: "ready", db_type: client.type, table: TABLE, poll_ms: POLL_MS });
  if (client.reason) {
    emit({ type: "log", level: "warn", message: `DB demo mode: ${client.reason}` });
  }

  /** @type {string | null} */
  let lastSeenAt = null;

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    try {
      const cmd = JSON.parse(line.trim());
      if (cmd.type === "ping") emit({ type: "pong" });
      if (cmd.type === "reset") {
        lastSeenAt = null;
        emit({ type: "log", level: "info", message: "cursor reset" });
      }
    } catch {
      // ignore malformed lines
    }
  });

  async function poll() {
    try {
      const rows = await queryNew(client, lastSeenAt);
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        lastSeenAt = /** @type {string} */ (last[TS_COL]) ?? new Date().toISOString();
        emit({
          type: "event",
          event: EVENT_TYPE,
          payload: {
            table: TABLE,
            rows,
            count: rows.length,
            cursor: { at: lastSeenAt, id: last[ID_COL] },
          },
        });
      }
    } catch (err) {
      emit({ type: "error", message: String(err) });
    }
    setTimeout(poll, POLL_MS);
  }

  // 首次延迟 1s，等待就绪信号传出后再轮询
  setTimeout(poll, 1000);
}

main().catch((err) => {
  emit({ type: "error", message: String(err) });
  process.exit(1);
});
