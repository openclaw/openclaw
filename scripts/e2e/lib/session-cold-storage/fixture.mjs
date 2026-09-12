import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

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
        "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId)
      .map(({ seq, event_json, created_at }) => ({ seq, event_json, created_at })),
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
