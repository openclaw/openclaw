import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, fixture, call, success, untouched, replace } from "./retained-repair-test-support.mjs";

const key = "agent:controller-test-agent:existing";
function rotate(f) {
  const db = new DatabaseSync(f.agentDatabasePath);
  db.exec("ALTER TABLE session_windows ADD COLUMN previous_session_id TEXT");
  for (const [id, previous] of [["second", "synthetic-generation"], ["third", "second"]]) {
    db.prepare("INSERT INTO session_windows VALUES (?,?,?)").run(id, key, previous);
    db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?,?)").run(id, id + "-generation");
    db.prepare("UPDATE session_nodes SET current_session_id=?,entry_json=?,updated_at=3 WHERE session_key=?")
      .run(id, JSON.stringify({ sessionId: id, previousSessionId: previous, updatedAt: 3 }), key);
  }
  db.close();
}

test("retained preparation accepts original canonical history after repeated session rotation", (t) => {
  const f = fixture(t);
  rotate(f);
  const before = readFileSync(f.agentDatabasePath);
  const snapshot = success(f, "snapshot", f.request);
  assert.equal(JSON.parse(snapshot.currentWitness[0])[5], "third");
  const sealed = success(f, "seal", snapshot);
  assert.deepEqual(success(f, "check", snapshot), sealed);
  assert.deepEqual(readFileSync(f.agentDatabasePath), before);
  untouched(f);
});

for (const [label, sql] of [
  ["newer rewrite watermark without lineage", "ALTER TABLE transcript_rewrite_watermarks ADD COLUMN updated_at INTEGER; UPDATE transcript_rewrite_watermarks SET generation='unexplained',updated_at=9999999999999 WHERE session_id='synthetic-generation'"],
  ["missing watermark", "DELETE FROM transcript_rewrite_watermarks WHERE session_id='synthetic-generation'"],
  ["foreign window", "UPDATE session_windows SET session_key='foreign' WHERE session_id='synthetic-generation'"],
  ["missing owner", "DELETE FROM session_nodes"],
]) test("retained history still refuses " + label, (t) => {
  const f = fixture(t);
  rotate(f);
  const db = new DatabaseSync(f.agentDatabasePath);
  db.exec(sql);
  db.close();
  const result = call(f, "snapshot", f.request);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /strict original and current transcript continuity/);
  untouched(f);
});

function deleteAgent(f, { missing = true, change = "" } = {}) {
  const db = new DatabaseSync(f.databasePath);
  db.exec(`CREATE TABLE agent_deletion_journal (agent_id TEXT PRIMARY KEY, operation_id TEXT,
    phase TEXT, database_paths_json TEXT, created_at INTEGER, cleanup_completed INTEGER, delete_files INTEGER)`);
  db.prepare("INSERT INTO agent_deletion_journal VALUES (?,?,?,?,?,1,?)")
    .run("controller-test-agent", "native-delete-operation", "retiring", JSON.stringify([f.agentDatabasePath]),
      Date.parse(f.record.createdAt) + 1, missing ? 1 : 0);
  if (change) db.exec(change);
  db.close();
  if (missing) unlinkSync(f.agentDatabasePath);
  else {
    const agent = new DatabaseSync(f.agentDatabasePath);
    agent.exec("DELETE FROM session_nodes; DELETE FROM session_windows; DELETE FROM transcript_rewrite_watermarks");
    agent.close();
  }
}

for (const missing of [true, false])
  test("retained preparation accepts completed native agent deletion with " + (missing ? "removed" : "retained") + " files", (t) => {
    const f = fixture(t);
    deleteAgent(f, { missing });
    const before = readFileSync(f.databasePath);
    const snapshot = success(f, "snapshot", f.request);
    assert.deepEqual(snapshot.currentWitness, []);
    const sealed = success(f, "seal", snapshot);
    assert.deepEqual(success(f, "check", snapshot), sealed);
    assert.deepEqual(readFileSync(f.databasePath), before);
    untouched(f);
  });

for (const [label, change] of [
  ["unrecorded", "DELETE FROM agent_deletion_journal"],
  ["pending", "UPDATE agent_deletion_journal SET cleanup_completed=0"],
  ["missing operation", "UPDATE agent_deletion_journal SET operation_id=''"],
  ["draining", "UPDATE agent_deletion_journal SET phase='draining'"],
  ["wrong agent", "UPDATE agent_deletion_journal SET agent_id='foreign'"],
  ["wrong database", "UPDATE agent_deletion_journal SET database_paths_json='[]'"],
  ["stale", "UPDATE agent_deletion_journal SET created_at=1"],
  ["future", "UPDATE agent_deletion_journal SET created_at=9007199254740991"],
  ["files unexpectedly removed", "UPDATE agent_deletion_journal SET delete_files=0"],
]) test("retained preparation refuses " + label + " agent deletion", (t) => {
  const f = fixture(t);
  deleteAgent(f, { change });
  assert.notEqual(call(f, "snapshot", f.request).status, 0);
  untouched(f);
});

test("retained deletion cannot excuse a replaced physical database", (t) => {
  const f = fixture(t);
  deleteAgent(f, { missing: false });
  replace(f.agentDatabasePath, f.beforeAgent);
  assert.notEqual(call(f, "snapshot", f.request).status, 0);
  untouched(f);
});
