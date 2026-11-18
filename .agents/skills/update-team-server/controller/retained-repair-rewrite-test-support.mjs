// Shared synthetic incident shape for boundary regressions and the scale workload.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { descriptor } from "./retained-repair-test-support.mjs";

export function prepareRewriteFixture(f) {
  const rewriteSessionIds = ["synthetic-generation", ...Array.from({ length: 35 }, (_, i) => `rewrite-${i}`)];
  const rotationSessionIds = Array.from({ length: 5 }, (_, i) => `rotation-${i}`);
  const database = new DatabaseSync(f.agentDatabasePath);
  database.exec("ALTER TABLE transcript_rewrite_watermarks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0; BEGIN");
  const add = (db, agent, id) => {
    const key = `agent:${agent}:${id}`;
    db.prepare("INSERT INTO session_nodes VALUES (?,?,?,?,NULL)")
      .run(key, id, JSON.stringify({ sessionId: id, updatedAt: 1 }), 1);
    db.prepare("INSERT INTO session_windows (session_id,session_key) VALUES (?,?)").run(id, key);
    db.prepare("INSERT INTO transcript_rewrite_watermarks (session_id,generation) VALUES (?,?)")
      .run(id, randomUUID());
  };
  for (const id of [...rewriteSessionIds.slice(1), ...rotationSessionIds])
    add(database, "controller-test-agent", id);
  // One rotated original was metadata-only: its empty window never had a token.
  database.prepare("DELETE FROM transcript_rewrite_watermarks WHERE session_id=?").run(rotationSessionIds[0]);
  database.exec(`CREATE TABLE IF NOT EXISTS transcript_events (session_id TEXT);
    CREATE TABLE IF NOT EXISTS session_transcript_cold_archives (session_id TEXT);
    CREATE TABLE IF NOT EXISTS session_transcript_cold_archive_chunks (session_id TEXT); COMMIT`);
  const currentSessions = database.prepare("SELECT count(*) AS count FROM session_nodes").get().count;
  database.close();
  const deletedAgent = "synthetic-deleted-agent";
  const deletedDatabasePath = join(dirname(dirname(dirname(f.agentDatabasePath))), deletedAgent, "agent", "openclaw-agent.sqlite");
  mkdirSync(dirname(deletedDatabasePath), { recursive: true });
  const deleted = new DatabaseSync(deletedDatabasePath);
  deleted.exec(`PRAGMA user_version=1;
    CREATE TABLE schema_meta (meta_key TEXT, role TEXT, schema_version INTEGER, agent_id TEXT);
    CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL, entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER);
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL);
    CREATE TABLE transcript_rewrite_watermarks (session_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
    CREATE TABLE session_transcript_archives (session_id TEXT, generation TEXT, session_key TEXT, archive_blob BLOB, archive_sha256 TEXT, encoding TEXT);`);
  deleted.prepare("INSERT INTO schema_meta VALUES ('primary','agent',1,?)").run(deletedAgent);
  deleted.exec("BEGIN");
  for (let i = 0; i < 411; i++) add(deleted, deletedAgent, `deleted-${i}`);
  deleted.exec("COMMIT");
  deleted.close();
  chmodSync(deletedDatabasePath, 0o600);
  const shared = new DatabaseSync(f.databasePath);
  shared.exec(`CREATE TABLE IF NOT EXISTS agent_deletion_journal (
    agent_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL DEFAULT '', phase TEXT,
    agent_dir TEXT NOT NULL, workspace_dir TEXT NOT NULL, sessions_dir TEXT NOT NULL,
    database_paths_json TEXT NOT NULL DEFAULT '[]', cleanup_paths_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, cleanup_completed INTEGER NOT NULL DEFAULT 0,
    delete_files INTEGER NOT NULL DEFAULT 1
  ) STRICT`);
  shared.close();
  const result = spawnSync("bash", ["-c",
    'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"', "rewrite-witness",
    process.execPath, f.library, "session-preservation-witness", f.initial, f.b, f.databasePath],
  { env: f.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  f.witness = JSON.parse(result.stdout);
  assert.equal(f.witness.length, currentSessions + 411);
  writeFileSync(f.originalPath, JSON.stringify(f.witness));
  const { path, ...originalDescriptor } = descriptor(f.originalPath);
  f.record.originalWitness = { name: path.split("/").at(-1), ...originalDescriptor };
  writeFileSync(f.journal, JSON.stringify(f.record) + "\n");
  f.request.source = descriptor(f.journal);
  f.original = readFileSync(f.journal);
  f.originalWitness = readFileSync(f.originalPath);
  f.originalJournalIdentity = descriptor(f.journal);
  return {
    originalWitnessTuples: f.witness.length, currentSessions, deletedDatabasePath,
    rewriteSessionIds, rotationSessionIds,
    evolve() {
      const updatedAt = Date.parse(f.record.createdAt) + 1;
      assert(updatedAt <= Date.now());
      const db = new DatabaseSync(f.agentDatabasePath);
      db.exec("BEGIN");
      for (const id of rewriteSessionIds)
        db.prepare("UPDATE transcript_rewrite_watermarks SET generation=?,updated_at=? WHERE session_id=?")
          .run(randomUUID(), updatedAt, id);
      for (const id of rotationSessionIds) {
        const sid = id + "-current", key = `agent:controller-test-agent:${id}`;
        db.prepare("INSERT INTO session_windows (session_id,session_key) VALUES (?,?)").run(sid, key);
        db.prepare("INSERT INTO transcript_rewrite_watermarks (session_id,generation,updated_at) VALUES (?,?,?)")
          .run(sid, randomUUID(), updatedAt);
        db.prepare("UPDATE session_nodes SET current_session_id=?,entry_json=?,updated_at=? WHERE session_key=?")
          .run(sid, JSON.stringify({ sessionId: sid, previousSessionId: id, updatedAt }), updatedAt, key);
      }
      db.exec("COMMIT");
      db.close();
      const retired = new DatabaseSync(deletedDatabasePath);
      retired.exec("DELETE FROM session_nodes; DELETE FROM session_windows; DELETE FROM transcript_rewrite_watermarks");
      retired.close();
      const owner = new DatabaseSync(f.databasePath);
      owner.prepare(`INSERT INTO agent_deletion_journal
        (agent_id,operation_id,phase,agent_dir,workspace_dir,sessions_dir,database_paths_json,created_at,cleanup_completed,delete_files)
        VALUES (?,?,'retiring',?,'','',?,?,1,0)`)
        .run(deletedAgent, randomUUID(), dirname(deletedDatabasePath), JSON.stringify([deletedDatabasePath]), updatedAt);
      owner.close();
    },
  };
}
