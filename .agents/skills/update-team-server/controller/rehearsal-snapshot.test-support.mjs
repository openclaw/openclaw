import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";
const library = process.env.REHEARSAL_SNAPSHOT_TEST_LIBRARY ?? new URL("./release-lib.mjs", import.meta.url).pathname;
export function makeRehearsalSnapshotFixture(t) {
  const f = makeReleaseFixture(t);
  const stateRoot = join(f.runtime, ".openclaw"), config = join(stateRoot, "openclaw.json"), shared = join(stateRoot, "state/openclaw.sqlite");
  mkdirSync(dirname(shared), { recursive: true });
  writeFileSync(config, JSON.stringify({ agents: { entries: { main: {} } } }), { mode: 0o600 });
  const db = new DatabaseSync(shared);
  db.exec("PRAGMA user_version=1; CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT); INSERT INTO schema_meta VALUES('primary','global',1,NULL); CREATE TABLE agent_databases(agent_id TEXT,path TEXT,schema_version INTEGER); CREATE TABLE delivery_queue_entries(id TEXT,payload TEXT); INSERT INTO delivery_queue_entries VALUES('pending','preserve queued work');");
  const agents = [];
  for (const id of ["main", "registered-only"]) {
    const file = join(stateRoot, "agents", id, "agent/openclaw-agent.sqlite");
    mkdirSync(dirname(file), { recursive: true });
    db.prepare("INSERT INTO agent_databases VALUES(?,?,1)").run(id, file);
    const agent = new DatabaseSync(file);
    agent.exec(`PRAGMA user_version=1; CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT); INSERT INTO schema_meta VALUES('primary','agent',1,'${id}'); CREATE TABLE session_participants(session_key TEXT,identity_namespace TEXT,actor_id TEXT,contribution_count INTEGER,first_prompted_at INTEGER,last_prompted_at INTEGER); CREATE TABLE retained(id INTEGER PRIMARY KEY,payload BLOB); CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT); CREATE TABLE session_windows(session_id TEXT,session_key TEXT); CREATE TABLE transcript_rewrite_watermarks(session_id TEXT,generation TEXT); INSERT INTO session_nodes VALUES('agent:${id}:main','session-${id}'); INSERT INTO session_windows VALUES('session-${id}','agent:${id}:main'); INSERT INTO transcript_rewrite_watermarks VALUES('session-${id}','generation');`);
    agent.close();
    const writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    writer.prepare("INSERT INTO retained VALUES(?,?)").run(1, Buffer.from(`committed WAL bytes ${id} 🦞`));
    agents.push({ id, file, writer });
  }
  db.close();
  t.after(() => { for (const agent of agents) if (agent.writer.isOpen) agent.writer.close(); });
  chmodSync(f.initial, 0o755);
  chmodSync(join(f.initial, "node_modules"), 0o755);
  mkdirSync(join(f.initial, "node_modules/sqlite-vec"));
  // The fixture has no vector tables; backup, WAL, digests and integrity remain native SQLite.
  writeFileSync(join(f.initial, "node_modules/sqlite-vec/index.js"), "exports.load=db=>db.function('vec_version',()=> 'fixture');");
  const seal = spawnSync(process.execPath, [library, "seal-tree", f.initial], { env: f.env, encoding: "utf8" });
  assert.equal(seal.status, 0, seal.stderr);
  // Simulate capacity independently of the test host's free-space budget. Snapshot I/O is real.
  const capacity = join(f.root, "capacity.mjs");
  writeFileSync(capacity, "import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.statfsSync; fs.statfsSync=(...args)=>({...original(...args),bavail:Number(process.env.SNAPSHOT_TEST_AVAILABLE),bsize:4096}); syncBuiltinESMExports();");
  const run = (label = "warm", available = 16 * 1024 * 1024) => spawnSync(process.execPath, ["--import", capacity, library, "snapshot-for-rehearsal", f.serving, f.initial, config, shared, label], { env: { ...f.env, SNAPSHOT_TEST_AVAILABLE: String(available) }, encoding: "utf8", timeout: 30000 });
  return { ...f, shared, config, agents, run };
}
