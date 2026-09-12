import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

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
    store[sessionKey] = { sessionId, sessionFile, updatedAt, label };
    sessions.push({ sessionId, sessionKey, label, nonce, ageDays });
  }
  await fs.writeFile(path.join(directory, "sessions.json"), JSON.stringify(store), { flag: "wx" });
  return sessions;
}

export async function runCli(context, args, { timeoutMs = 120_000 } = {}) {
  try {
    const result = await execute(process.execPath, [context.entry, ...args], {
      env: context.env,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  } catch (error) {
    // execFile's default message includes argv, including the Gateway token.
    // eslint-disable-next-line preserve-caught-error -- Drop credential-bearing command arguments.
    throw new Error(`OpenClaw ${args[0]} failed: ${error.stderr || error.code || "unknown error"}`);
  }
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
        "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId)
      .map((row) => ({ ...row })),
  );
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const archives = readColdArchives(context.env.OPENCLAW_STATE_DIR);
    if (
      JSON.stringify(archives.map((row) => row.session_id)) ===
      JSON.stringify([...expectedIds].sort())
    ) {
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
