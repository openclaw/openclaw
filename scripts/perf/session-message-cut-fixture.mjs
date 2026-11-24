// Synthetic-only fixture: node --import ./scripts/tsx.mjs scripts/perf/session-message-cut-fixture.mjs <fresh-dir> [GiB=35]
// Seeds real owner-written large/control transcripts plus unrelated legacy-text sessions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = path.resolve(process.argv[2]);
assert(!fs.existsSync(root), "Use a fresh directory");
fs.mkdirSync(root, { recursive: true });
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
const gib = Number(process.argv[3] ?? 35);
assert(Number.isFinite(gib) && gib >= 0 && gib <= 75);
const agent = await import("../../src/state/openclaw-agent-db.js");
const { replaceSessionEntryInDatabase } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-mutation.js");
const { appendTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const options = { agentId: "main", env: process.env, path: path.join(root, "agent.sqlite") };
const db = agent.openOpenClawAgentDatabase(options);
for (const [name, count] of [
  ["oom", 20000],
  ["control", 2000],
]) {
  const scope = { ...options, sessionKey: `agent:main:${name}`, sessionId: `${name}-source` };
  agent.runOpenClawAgentWriteTransaction(() => {
    replaceSessionEntryInDatabase(db, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "synthetic",
    });
    function* events() {
      yield {
        type: "session",
        id: scope.sessionId,
        version: 3,
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      for (let i = 0; i < count; i++) {
        yield {
          type: "message",
          id: `e${i}`,
          parentId: i ? `e${i - 1}` : null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: i % 2 ? "assistant" : "user", content: "x".repeat(32768) },
        };
      }
    }
    appendTranscriptEventsInTransaction(db, scope, events(), {
      scheduleProjectionReconcile: false,
    });
  }, options);
}
await agent.closeOpenClawAgentDatabasesAsync();
await closeOpenClawStateDatabaseAsync();
await drainGlobalSingletonLifecycleState();
// Offline synthetic bootstrap, after every runtime handle has joined.
const native = new DatabaseSync(options.path);
native.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON");
const node = native.prepare(
  "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at,entry_valid) VALUES(?,?,?,1,1)",
);
const window = native.prepare(
  "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,1,1)",
);
const event = native.prepare(
  "INSERT INTO transcript_events(session_id,seq,event_json,event_utf8_bytes,created_at,navigation_type,message_role) VALUES(?,?,?,?,1,'message','toolResult')",
);
const payloads = Array.from({ length: 20 }, (_, i) =>
  JSON.stringify({
    type: "message",
    id: `background-${i}`,
    parentId: i ? `background-${i - 1}` : null,
    message: { role: "toolResult", content: "synthetic ".repeat(4000) },
  }),
);
const rows = Math.ceil((gib * 1024 ** 3) / payloads[0].length);
const sessions = 17688;
for (let batch = 0; batch < sessions; batch += 100) {
  native.exec("BEGIN");
  for (let i = batch; i < Math.min(batch + 100, sessions); i++) {
    const id = `background-${i}`,
      key = `agent:main:${id}`;
    node.run(key, id, JSON.stringify({ sessionId: id, updatedAt: 1 }));
    window.run(id, key);
    for (let seq = 0; seq * sessions + i < rows; seq++) {
      const payload = payloads[seq % 20];
      event.run(id, seq, payload, Buffer.byteLength(payload));
    }
  }
  native.exec("COMMIT");
}
native.close();
const fixture = {
  format: "synthetic-message-cut-v1",
  sessions: sessions + 2,
  backgroundRows: rows,
  largeEvents: 20000,
  eventBytes: 32768,
  bytes: fs.statSync(options.path).size,
};
fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(fixture));
console.log(JSON.stringify(fixture));
