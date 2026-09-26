import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../../lib/sqlite-transcript-payload.mjs";

const state = "/home/node/.openclaw";
const workspace = path.join(state, "workspace");
const agentPath = path.join(state, "agents/main/agent/openclaw-agent.sqlite");
const sharedPath = path.join(state, "state/openclaw.sqlite");
const recordPath = path.join(state, "container-image-fixture.json");
const corpusPath = "/proof/state-corpus/2026.9.2";
const setup = { version: 1, setupCompletedAt: "2026-07-02T00:00:00.000Z" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const schemaVersions = readJson("/app/package.json").openclaw.schemaVersions;
function open(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    return fn(db);
  } finally {
    db.close();
  }
}
function logicalSnapshot(file) {
  return open(file, (db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    return {
      version: db.prepare("PRAGMA user_version").get().user_version,
      schema: db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql",
        )
        .all()
        // Match the plain objects read back from the persisted JSON preimage.
        .map((row) => Object.assign({}, row)),
      tables: Object.fromEntries(
        tables.map(({ name }) => [
          name,
          db
            .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
            .all()
            .map((row) => JSON.stringify(row))
            .toSorted(),
        ]),
      ),
    };
  });
}
function readSession(file, { sessionKey, sessionId }) {
  return open(file, (db) => {
    const row = db
      .prepare("SELECT current_session_id FROM session_nodes WHERE session_key=?")
      .get(sessionKey);
    assert.equal(row?.current_session_id, sessionId);
    const events = db
      .prepare(
        `SELECT ${sqliteTranscriptPayloadColumns(db)} FROM transcript_events WHERE session_id=? ORDER BY seq`,
      )
      .all(sessionId);
    return events.map((event) => readSqliteTranscriptPayload(event));
  });
}
function assertSession(file) {
  for (const session of readJson(recordPath).sessions) {
    assert.deepEqual(readSession(file, session), session.events);
  }
}
function backups(file) {
  return fs
    .readdirSync(path.dirname(file))
    .filter(
      (name) =>
        name.startsWith(`${path.basename(file)}.pre-startup-migration-`) && name.endsWith(".bak"),
    )
    .map((name) => path.join(path.dirname(file), name));
}
function verifyBackup(file, expected) {
  const matches = backups(file);
  assert.equal(matches.length, 1, `Expected exactly one retained-schema backup: ${file}`);
  assert.deepEqual(logicalSnapshot(matches[0]), expected, "Backup changed retained rows/schema");
  const backupId = path
    .basename(matches[0])
    .slice(`${path.basename(file)}.pre-startup-migration-`.length, -".bak".length);
  assert.match(backupId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  return { path: matches[0], backupId, sha256: sha(fs.readFileSync(matches[0])) };
}
function verifyWorkspace(required) {
  const legacy = path.join(workspace, "openclaw-workspace-state.json");
  if (!required && fs.existsSync(legacy)) {
    assert.deepEqual(readJson(legacy), setup);
    return { legacyPreserved: true };
  }
  assert(!fs.existsSync(legacy), "Legacy workspace state was not retired");
  const archives = fs
    .readdirSync(workspace)
    .filter((name) => name.startsWith("openclaw-workspace-state.json.migrated."));
  assert.equal(archives.length, 1);
  assert.deepEqual(readJson(path.join(workspace, archives[0])), setup);
  open(sharedPath, (db) => {
    const rows = db
      .prepare("SELECT setup_completed_at FROM workspace_setup_state WHERE workspace_path=?")
      .all(workspace);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].setup_completed_at, setup.setupCompletedAt);
  });
  return { archive: archives[0] };
}
function seed(unsafe) {
  assert(!fs.existsSync(sharedPath) && !fs.existsSync(agentPath));
  // This pair was produced by the released writers, including the deletion journal
  // and registry. Do not manufacture a journal for an unrelated older shared DB.
  const corpusHashes = {
    "manifest.json": "4bea2b9a37d9fe9074be78ac7b671216acc75f436d06023ba184ba4ddc995e7d",
    "state/state/openclaw.sqlite":
      "fb532c2017744b962ea20d28cf4c5db04a822050617e88d86c275da9de5f11b1",
    "state/agents/main/agent/openclaw-agent.sqlite":
      "b6a2acab9c22ab197a5e1e19787b3be59585fab7719f6553ab545113d21b5e55",
  };
  for (const [file, expected] of Object.entries(corpusHashes)) {
    assert.equal(sha(fs.readFileSync(path.join(corpusPath, file))), expected, file);
  }
  const manifest = readJson(path.join(corpusPath, "manifest.json"));
  assert.equal(manifest.release, "2026.9.2");
  assert.equal(manifest.source, "3928bad9badfcb6c7d140530435e806fb8092190");
  fs.cpSync(path.join(corpusPath, "state"), state, { recursive: true });
  const sessions = manifest.sessions.map((session) => ({
    ...session,
    events: readSession(agentPath, session),
  }));
  if (unsafe) {
    const db = new DatabaseSync(agentPath);
    try {
      db.prepare("UPDATE schema_meta SET schema_version=18 WHERE meta_key='primary'").run();
    } finally {
      db.close();
    }
  }
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "openclaw-workspace-state.json"), JSON.stringify(setup));
  const config = readJson(path.join(state, "openclaw.json"));
  assert.equal(config.agents.defaults.workspace, "/home/fixture/workspace");
  assert.equal(config.agents.entries.main.workspace, "/home/fixture/workspace");
  assert.equal(config.agents.entries.main.agentDir, "/home/fixture/.openclaw/agents/main/agent");
  config.agents.defaults.workspace = workspace;
  config.agents.entries.main.workspace = workspace;
  config.agents.entries.main.agentDir = path.dirname(agentPath);
  config.gateway = {
    mode: "local",
    auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN },
  };
  config.plugins = { enabled: false };
  fs.writeFileSync(path.join(state, "openclaw.json"), JSON.stringify(config, null, 2));
  const record = {
    unsafe,
    corpus: { release: manifest.release, source: manifest.source, hashes: corpusHashes },
    sessions,
    agentSha256: sha(fs.readFileSync(agentPath)),
    sharedSha256: sha(fs.readFileSync(sharedPath)),
    agent: logicalSnapshot(agentPath),
    shared: logicalSnapshot(sharedPath),
  };
  assert.equal(record.shared.version, 15);
  assert.equal(record.agent.version, 19);
  open(sharedPath, (db) => {
    assert.equal(db.prepare("SELECT count(*) AS count FROM agent_deletion_journal").get().count, 0);
    const rows = db.prepare("SELECT agent_id, path FROM agent_databases").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, "main");
    assert.equal(rows[0].path, "agents/main/agent/openclaw-agent.sqlite");
    assert.equal(path.resolve(state, rows[0].path), agentPath);
  });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
}
function verify(mode) {
  const before = readJson(recordPath);
  assertSession(agentPath);
  if (mode !== "migrated") {
    assert.equal(
      sha(fs.readFileSync(agentPath)),
      before.agentSha256,
      "Refusal mutated protected agent bytes",
    );
    assert.deepEqual(logicalSnapshot(agentPath), before.agent);
    if (mode === "old-shape") {
      assert.equal(
        sha(fs.readFileSync(sharedPath)),
        before.sharedSha256,
        "Startup control repaired shared state",
      );
      assert.deepEqual(readJson(path.join(workspace, "openclaw-workspace-state.json")), setup);
    } else if (sha(fs.readFileSync(sharedPath)) !== before.sharedSha256) {
      verifyBackup(sharedPath, before.shared);
    }
    console.log(
      JSON.stringify({
        mode,
        protectedAgentSha256: before.agentSha256,
        workspace: verifyWorkspace(false),
      }),
    );
    return;
  }
  for (const [file, expected] of [
    [agentPath, schemaVersions.agent],
    [sharedPath, schemaVersions.state],
  ]) {
    open(file, (db) => {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, expected);
      assert.equal(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'").get()
          .schema_version,
        expected,
      );
    });
  }
  const agentBackup = verifyBackup(agentPath, before.agent);
  const sharedBackup = verifyBackup(sharedPath, before.shared);
  assert.equal(agentBackup.backupId, sharedBackup.backupId, "Migration backups are not paired");
  assertSession(agentBackup.path);
  console.log(
    JSON.stringify({
      mode,
      agentBackup,
      sharedBackup,
      workspace: verifyWorkspace(true),
    }),
  );
}
async function ready() {
  const response = await fetch("http://127.0.0.1:18789/readyz", {
    signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ready, true);
  console.log(JSON.stringify(result));
}
function rpc(method, params) {
  const result = spawnSync(
    process.execPath,
    [
      "/app/openclaw.mjs",
      "gateway",
      "call",
      method,
      "--token",
      process.env.OPENCLAW_GATEWAY_TOKEN,
      "--json",
      "--params",
      JSON.stringify(params),
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const match of result.stdout.matchAll(/^[ \t]*[[{]/gm)) {
    try {
      return JSON.parse(result.stdout.slice(match.index));
    } catch {
      /* CLI diagnostics may precede JSON. */
    }
  }
  throw new Error("Missing public RPC JSON response");
}
const [action, mode] = process.argv.slice(2);
if (action === "seed") {
  seed(mode === "unsafe");
} else if (action === "verify") {
  verify(mode);
} else if (action === "ready") {
  await ready();
} else if (action === "history") {
  rpc("update.status", {});
  const histories = readJson(recordPath).sessions.map((session) => {
    const value = rpc("chat.history", { sessionKey: session.sessionKey, limit: 100 });
    assert(
      value.messages?.some((entry) => {
        const message = entry.message ?? entry;
        return (
          message.role === "user" &&
          message.content?.some(
            (part) => part.type === "text" && part.text === session.transcriptText,
          )
        );
      }),
      `Retained user message is missing from public chat.history: ${session.sessionKey}`,
    );
    return { sessionKey: session.sessionKey, value };
  });
  console.log(JSON.stringify(histories));
} else {
  throw new Error(`Unknown fixture action: ${action}`);
}
