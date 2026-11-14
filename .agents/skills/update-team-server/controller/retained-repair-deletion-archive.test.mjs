import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ready, toStartIntent, lifecycle, invoke, test, digest } from "./retained-repair-lifecycle-test-support.mjs";
import { prepareRewriteFixture } from "./retained-repair-rewrite-test-support.mjs";

function archivedDeletion(t) {
  const f = ready(t), shape = prepareRewriteFixture(f);
  const tuples = f.witness.map(JSON.parse).filter(tuple => tuple[1] === shape.deletedDatabasePath);
  assert.equal(tuples.length, 411);
  const db = new DatabaseSync(shape.deletedDatabasePath);
  db.exec("BEGIN");
  for (const tuple of tuples) {
    const blob = Buffer.from("synthetic archived original " + tuple[5]);
    db.prepare("INSERT INTO session_transcript_archives VALUES (?,?,?,?,?,?)")
      .run(tuple[5], tuple[7], tuple[6], blob, digest(blob), "identity");
  }
  db.exec("COMMIT");
  db.close();
  shape.evolve();
  // Native recovery preserves the earlier intent time, not the completion time.
  const shared = new DatabaseSync(f.databasePath);
  shared.prepare("UPDATE agent_deletion_journal SET created_at=? WHERE agent_id=?")
    .run(Date.parse(f.record.createdAt) - 1000, "synthetic-deleted-agent");
  shared.close();
  return { f, shape, tuple: tuples[0] };
}

test("retained repair accepts 36 rewrites, 5 rotations and 411 archived deletions with pre-journal intent", t => {
  const { f, shape } = archivedDeletion(t);
  const original = readFileSync(f.originalPath), retired = readFileSync(shape.deletedDatabasePath);
  const intent = toStartIntent(f);
  assert.equal(intent.record.phase, "REPAIR_START_INTENT");
  assert.equal(lifecycle(f, "inspect", intent).record.phase, "REPAIR_START_INTENT");
  assert.deepEqual(readFileSync(f.originalPath), original);
  assert.deepEqual(readFileSync(shape.deletedDatabasePath), retired);
});

for (const failure of ["corrupt encoded hash", "missing exact archive"])
  test("pre-journal deletion intent cannot excuse " + failure, t => {
    const { f, shape, tuple } = archivedDeletion(t);
    const db = new DatabaseSync(shape.deletedDatabasePath);
    if (failure === "corrupt encoded hash")
      db.prepare("UPDATE session_transcript_archives SET archive_sha256=? WHERE session_id=? AND generation=?")
        .run("0".repeat(64), tuple[5], tuple[7]);
    else db.prepare("DELETE FROM session_transcript_archives WHERE session_id=? AND generation=?").run(tuple[5], tuple[7]);
    db.close();
    const before = readFileSync(f.journal);
    const result = invoke(f, "retained-repair-build", "begin", f.request);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /strict original and current transcript continuity/);
    assert.deepEqual(readFileSync(f.journal), before);
  });
