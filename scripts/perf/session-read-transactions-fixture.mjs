/**
 * Synthetic schema-39 fixture; run with node --import ./scripts/tsx.mjs.
 * --database-only omits the unrelated 62,000-file workspace for SQL owner measurements.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    sessions: { type: "string", default: "10000" },
    events: { type: "string", default: "1000000" },
    "target-events": { type: "string", default: "100000" },
    "body-bytes": { type: "string", default: "40000" },
    "target-body-bytes": { type: "string", default: "1024" },
    "snapshot-bytes": { type: "string", default: "65536" },
    "workspace-only": { type: "boolean" },
    "database-only": { type: "boolean" },
    "idempotency-keys": { type: "boolean", default: false },
  },
});
assert(values.root, "--root is required and must not already exist");
assert(!(values["workspace-only"] && values["database-only"]));
const positive = (input) => {
  const number = Number(input);
  assert(Number.isSafeInteger(number) && number > 0);
  return number;
};
const sessionCount = positive(values.sessions);
const eventCount = positive(values.events);
const targetEvents = positive(values["target-events"]);
const bodyBytes = positive(values["body-bytes"]);
const targetBodyBytes = positive(values["target-body-bytes"]);
const snapshotBytes = positive(values["snapshot-bytes"]);
assert(sessionCount > 1 && eventCount - targetEvents >= (sessionCount - 1) * 2);
const root = path.resolve(values.root);
if (values["workspace-only"]) {
  const manifest = path.join(root, "fixture.json");
  const summary = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(summary.format, "openclaw-session-read-transactions-v1");
  summary.workspace = createSyntheticWorkspace(path.join(root, "workspace"));
  writeFileSync(manifest, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary.workspace));
  process.exit(0);
}
mkdirSync(root, { mode: 0o700 });
for (const directory of ["home", "tmp", "workspace"]) {
  mkdirSync(path.join(root, directory));
}
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  TMPDIR: path.join(root, "tmp"),
});
writeFileSync(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
    agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
    plugins: { enabled: false },
    cron: { enabled: false },
  }),
);
const owner = await import("../../src/state/openclaw-agent-db.ts");
const state = await import("../../src/state/openclaw-state-db.ts");
const options = { agentId: "main" };
const database = owner.openOpenClawAgentDatabase(options);
const db = database.db;
const timestamp = "2026-01-01T00:00:00.000Z";
const now = Date.parse(timestamp);
const sessionId = (index) => `lane2035-session-${String(index).padStart(5, "0")}`;
const key = (index) => `agent:main:${sessionId(index)}`;
const id = (seq) => `event-${String(seq).padStart(6, "0")}`;
const started = performance.now();
let inserted = 0;
let payloadBytes = 0;
try {
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 39);
  // Raw insertion is limited to this newly created offline synthetic fixture.
  const node = db.prepare(`INSERT INTO session_nodes
    (session_key,current_session_id,entry_json,updated_at,entry_valid,display_name)
    VALUES(?,?,?,?,1,?)`);
  const window = db.prepare(`INSERT INTO session_windows
    (session_id,session_key,created_at,updated_at,transcript_updated_at)
    VALUES(?,?,?,?,?)`);
  const watermark = db.prepare(`INSERT INTO transcript_rewrite_watermarks
    (session_id,generation,updated_at) VALUES(?,?,?)`);
  const snapshot = db.prepare(`INSERT INTO session_entry_snapshots
    (session_key,field,value_json) VALUES(?,'skillsSnapshot',?)`);
  const event = db.prepare(`INSERT INTO transcript_events
    (session_id,seq,event_json,created_at,event_utf8_bytes,navigation_type,
     message_role,navigation_last_type,navigation_valid)
    VALUES(?,?,?,?,?,?,?,?,1)`);
  const identity = db.prepare(`INSERT INTO transcript_event_identities
    (session_id,event_id,seq,event_type,parent_id,created_at,message_idempotency_key)
    VALUES(?,?,?,?,?,?,?)`);
  const active = db.prepare(`INSERT INTO session_transcript_active_events
    (session_id,active_position,event_seq,message_position,context_eligible)
    VALUES(?,?,?,?,1)`);
  const projection = db.prepare(`INSERT INTO session_transcript_index_state
    (session_id,indexed_seq,leaf_event_id,needs_rebuild,active_event_count,
     active_message_count,updated_at) VALUES(?,?,?,0,?,?,?)`);
  const snapshotJson = JSON.stringify({ prompt: "s".repeat(snapshotBytes), skills: [] });
  owner.runOpenClawAgentWriteTransaction(() => {
    for (let index = 0; index < sessionCount; index++) {
      const displayName = `Synthetic read benchmark ${index}`;
      node.run(
        key(index),
        sessionId(index),
        JSON.stringify({
          sessionId: sessionId(index),
          updatedAt: now + index,
          displayName,
        }),
        now + index,
        displayName,
      );
      window.run(sessionId(index), key(index), now, now + index, now);
      watermark.run(sessionId(index), `synthetic-generation-${index}`, now);
      snapshot.run(key(index), snapshotJson);
    }
  }, options);
  console.log(JSON.stringify({ phase: "metadata-ready", root, path: database.path, sessionCount }));
  // Inline text models supported legacy rows; no sparse padding, fake tables, or Team data.
  const padding = Array.from({ length: 64 }, (_, index) =>
    createHash("sha256").update(`synthetic-padding-${index}`).digest("hex"),
  ).join("");
  const longBody = padding.repeat(Math.ceil(bodyBytes / padding.length)).slice(0, bodyBytes);
  const shortBody = padding
    .repeat(Math.ceil(targetBodyBytes / padding.length))
    .slice(0, targetBodyBytes);
  const others = eventCount - targetEvents;
  for (let index = 0; index < sessionCount; index++) {
    const count =
      index === 0
        ? targetEvents
        : Math.floor(others / (sessionCount - 1)) + Number(index <= others % (sessionCount - 1));
    for (let start = 0; start < count; start += 2000) {
      owner.runOpenClawAgentWriteTransaction(() => {
        for (let seq = start; seq < Math.min(count, start + 2000); seq++) {
          const role = seq % 2 === 0 ? "assistant" : "user";
          const parentId = seq > 1 ? id(seq - 1) : null;
          const idempotencyKey = values["idempotency-keys"] ? `result-${index}-${seq}` : null;
          const record =
            seq === 0
              ? { type: "session", version: 3, id: sessionId(index), timestamp }
              : {
                  type: "message",
                  id: id(seq),
                  parentId,
                  timestamp,
                  message: {
                    role,
                    content: `${index}:${seq}:${index === 0 ? shortBody : longBody}`,
                    timestamp: now,
                    ...(idempotencyKey ? { idempotencyKey } : {}),
                  },
                };
          const json = JSON.stringify(record);
          const bytes = Buffer.byteLength(json);
          event.run(
            sessionId(index),
            seq,
            json,
            now,
            bytes,
            record.type,
            seq === 0 ? null : role,
            record.type,
          );
          if (seq > 0) {
            identity.run(sessionId(index), id(seq), seq, "message", parentId, now, idempotencyKey);
            active.run(sessionId(index), seq - 1, seq, seq - 1);
          }
          payloadBytes += bytes;
          inserted++;
        }
        if (start + 2000 >= count) {
          projection.run(sessionId(index), count - 1, id(count - 1), count - 1, count - 1, now);
        }
      }, options);
    }
    if (index === 0 || index % 250 === 0 || index === sessionCount - 1) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      console.log(
        JSON.stringify({
          phase: "events",
          sessions: index + 1,
          inserted,
          databaseBytes: statSync(database.path).size,
          elapsedMs: performance.now() - started,
        }),
      );
      await yieldTurn();
    }
  }
  const { certifySessionCanonicalValidationPending } =
    await import("../../src/config/sessions/session-canonical-validation-readiness.ts");
  await certifySessionCanonicalValidationPending(options);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM session_canonical_validation_pending").get().count,
    0,
  );
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal(inserted, eventCount);
  const workspace = values["database-only"]
    ? undefined
    : createSyntheticWorkspace(path.join(root, "workspace"));
  const summary = {
    format: "openclaw-session-read-transactions-v1",
    root,
    databasePath: database.path,
    schemaVersion: 39,
    sessionCount,
    eventCount,
    populatedSessions: sessionCount,
    target: { sessionId: sessionId(0), sessionKey: key(0), events: targetEvents },
    bodyBytes,
    targetBodyBytes,
    snapshotBytes,
    idempotencyKeys: values["idempotency-keys"],
    payloadBytes,
    databaseBytes: statSync(database.path).size,
    elapsedMs: performance.now() - started,
    platform: process.platform,
    filesystem: "Use the host filesystem; no btrfs claim",
    workspace,
  };
  writeFileSync(path.join(root, "fixture.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
} finally {
  await owner.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}

function createSyntheticWorkspace(workspace) {
  const body = Buffer.alloc(18000, "synthetic workspace fixture\n");
  for (let directory = 0; directory < 620; directory++) {
    const folder = path.join(workspace, `dir-${directory}`);
    mkdirSync(folder);
    for (let file = 0; file < 100; file++) {
      writeFileSync(path.join(folder, `file-${file}.txt`), body, { flag: "wx" });
    }
  }
  return { files: 62000, bytes: 62000 * body.length };
}
