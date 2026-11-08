import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "fixture-json": { type: "string" } } });
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(
  stateDir && path.isAbsolute(stateDir),
  "Set OPENCLAW_STATE_DIR to a fresh synthetic state directory",
);
// Refuse existing state instead of appending another fixture to an earlier run.
await mkdir(stateDir);
const { CURRENT_SESSION_VERSION } = await import("../../src/agents/sessions/session-manager.js");
const { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { appendTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { waitForSessionTranscriptProjection } =
  await import("../../src/config/sessions/session-transcript-reconcile.js");

function text(index: number, size: number) {
  return Array.from({ length: Math.ceil(size / 64) }, (_, offset) =>
    `${index}:${offset}:synthetic tool stdout abcdefghijklmnopqrstuvwxyz 0123456789\n`.padEnd(
      64,
      ".",
    ),
  )
    .join("")
    .slice(0, size);
}

const timestamp = "2026-01-01T00:00:00.000Z";
const entries: unknown[] = [
  {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "synthetic-session",
    cwd: "/synthetic",
    timestamp,
  },
];
let parentId: string | null = null;
for (let index = 0; index < 400; index++) {
  for (const [suffix, message] of [
    [
      "u",
      {
        role: "user",
        content: `Synthetic request ${index}`,
        timestamp: index,
        __openclaw: {
          media: [{ url: `media://inbound/synthetic-${index}.txt`, contentType: "text/plain" }],
        },
      },
    ],
    [
      "a",
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "exec",
            arguments: { command: `synthetic ${index}` },
          },
        ],
        provider: "synthetic",
        model: "synthetic",
        api: "synthetic",
        stopReason: "toolUse",
        usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
        timestamp: index,
      },
    ],
    [
      "t",
      {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "exec",
        content: [{ type: "text", text: text(index, 8192) }],
        isError: false,
        timestamp: index,
      },
    ],
  ] as const) {
    const id = `e${index}-${suffix}`;
    entries.push({ type: "message", id, parentId, timestamp, message });
    parentId = id;
  }
  if (index === 200) {
    entries.push({
      type: "compaction",
      id: "compaction",
      parentId,
      firstKeptEntryId: "e180-u",
      summary: text(400, 8192),
      tokensBefore: 500000,
      timestamp,
    });
    parentId = "compaction";
  }
  if (index === 220) {
    const branchParent = parentId;
    for (let side = 0; side < 20; side++) {
      entries.push({
        type: "message",
        id: `side-${side}`,
        parentId: branchParent,
        timestamp,
        message: { role: "user", content: text(500 + side, 2048), timestamp: side },
      });
    }
  }
}
assert.equal(entries.length, 1222);
const json = JSON.stringify(entries);
if (values["fixture-json"]) {
  await writeFile(values["fixture-json"], json, { flag: "wx" });
}
const scope = {
  agentId: "main",
  env: process.env,
  sessionId: "synthetic-session",
  sessionKey: "agent:main:synthetic-session",
};
try {
  runOpenClawAgentWriteTransaction(
    (database) =>
      writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 }),
    scope,
  );
  for (let offset = 0; offset < entries.length; offset += 150) {
    runOpenClawAgentWriteTransaction(
      (database) =>
        appendTranscriptEventsInTransaction(database, scope, entries.slice(offset, offset + 150)),
      scope,
    );
  }
  await waitForSessionTranscriptProjection(scope);
} finally {
  await closeOpenClawAgentDatabasesAsync(stateDir);
}
console.log(
  JSON.stringify({
    seeded: entries.length,
    fixtureSha256: hash("sha256", json, "hex"),
    fixtureBytes: Buffer.byteLength(json),
    sessionVersion: CURRENT_SESSION_VERSION,
    projectionReady: true,
    storePath: path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
  }),
);
