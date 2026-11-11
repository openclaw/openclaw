import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../../lib/sqlite-transcript-payload.mjs";

// Use the supported legacy import boundary; never backdate the live database.
export async function seedColdStorageFixture({ stateDir, workspaceDir }) {
  const directory = path.join(stateDir, "agents", "main", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const sessions = [];
  const store = {};
  for (const [label, ageDays] of [
    ["old", 60],
    ["middle", 14],
    ["recent", 1],
  ]) {
    const sessionId = randomUUID();
    const sessionKey = `agent:main:cold-release:${label}`;
    const nonce = randomBytes(12).toString("hex");
    const updatedAt = Date.now() - ageDays * 86_400_000;
    const timestamp = new Date(updatedAt).toISOString();
    const events = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: workspaceDir },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: `The recall code is ${nonce}. Remember it.`,
          timestamp: updatedAt,
        },
      },
      {
        type: "message",
        id: "assistant",
        parentId: "user",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will remember it." }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4-mini",
          stopReason: "stop",
          timestamp: updatedAt,
        },
      },
    ];
    const sessionFile = path.join(directory, `${sessionId}.jsonl`);
    await fs.writeFile(
      sessionFile,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      { flag: "wx" },
    );
    // Doctor imports file mutation time, not timestamps inside messages.
    await fs.utimes(sessionFile, new Date(updatedAt), new Date(updatedAt));
    store[sessionKey] = { sessionId, sessionFile, updatedAt, label };
    sessions.push({ sessionId, sessionKey, label, nonce, ageDays });
  }
  await fs.writeFile(path.join(directory, "sessions.json"), JSON.stringify(store), { flag: "wx" });
  return sessions;
}

export function runCli(context, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [context.entry, ...args],
      {
        env: context.env,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          // execFile's message and command contain the Gateway token; retain only diagnostics.
          const diagnostics = [stderr, stdout].filter(Boolean).join("\n");
          reject(
            new Error(
              `OpenClaw ${args[0]} failed: ${diagnostics || error.code || "unknown error"}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function gatewayCall(context, method, params, { timeoutMs = 30_000 } = {}) {
  return JSON.parse(
    await runCli(
      context,
      [
        "gateway",
        "call",
        method,
        "--url",
        context.url,
        "--token",
        context.token,
        "--timeout",
        String(timeoutMs),
        "--json",
        "--params",
        JSON.stringify(params),
      ],
      { timeoutMs: timeoutMs + 10_000 },
    ),
  );
}

export function databasePath(stateDir) {
  return path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
}

function readDatabase(stateDir, read) {
  const database = new DatabaseSync(databasePath(stateDir), { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

export function readTranscriptRows(stateDir, sessionId) {
  return readDatabase(stateDir, (database) =>
    database
      .prepare(
        `SELECT seq, ${sqliteTranscriptPayloadColumns(database)}, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId)
      .map((row) => ({
        seq: row.seq,
        event_json: readSqliteTranscriptPayload(row),
        created_at: row.created_at,
      })),
  );
}

export function assertColdTranscriptRows(stateDir, session) {
  assert.equal(
    readColdArchives(stateDir).find((archive) => archive.session_id === session.sessionId)
      ?.event_count,
    session.rows.length,
    "archive must preserve the original event count",
  );
  if (process.env.OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE === "legacy") {
    const rows = readTranscriptRows(stateDir, session.sessionId);
    assert.deepEqual(rows, [], "legacy archival must remove hot event rows");
    return rows;
  }
  const rows = readDatabase(stateDir, (database) =>
    database
      .prepare(
        `SELECT seq, ${sqliteTranscriptPayloadColumns(database)}, navigation_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq`,
      )
      .all(session.sessionId),
  );
  assert.deepEqual(
    rows.map(({ seq, created_at }) => ({ seq, created_at })),
    session.rows.map(({ seq, created_at }) => ({ seq, created_at })),
    "archival must retain event positions and timestamps",
  );
  for (const [index, row] of rows.entries()) {
    const original = session.rows[index];
    const event = JSON.parse(original.event_json);
    if (event.type === "message") {
      assert.equal(row.event_json, null, "fixture message payload must be offloaded");
      assert.equal(row.event_zstd, null, "fixture message payload must be offloaded");
      const navigation = JSON.parse(row.navigation_json).navigation;
      assert.equal(navigation.type, event.type);
      assert.equal(navigation.id, event.id);
      assert.equal(navigation.parentId, event.parentId);
      assert.equal(navigation.message.role, event.message.role);
    } else {
      // Headers remain resident so opening a cold transcript can retain its session metadata.
      assert.equal(readSqliteTranscriptPayload(row), original.event_json);
    }
  }
  return rows;
}

export function readColdArchives(stateDir) {
  return readDatabase(stateDir, (database) =>
    database
      .prepare(
        "SELECT session_id, archive_name, storage, event_count FROM session_transcript_cold_archives ORDER BY session_id",
      )
      .all(),
  );
}

export async function waitForArchives(context, expectedIds, { timeoutMs = 95_000 } = {}) {
  const expected = JSON.stringify(expectedIds.toSorted((a, b) => a.localeCompare(b)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const archives = readColdArchives(context.env.OPENCLAW_STATE_DIR);
    if (JSON.stringify(archives.map((row) => row.session_id)) === expected) {
      const status = await gatewayCall(context, "sessions.storage.status", {});
      assert.equal(status.maintenance.lastError, null);
      if (!status.maintenance.running) {
        return archives;
      }
    }
    await delay(500);
  }
  throw new Error(
    `Automatic transcript archival timed out: ${JSON.stringify(await gatewayCall(context, "sessions.storage.status", {}))}`,
  );
}
