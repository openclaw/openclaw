import assert from "node:assert/strict";
import { readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, fixture, call, success, untouched, replace, journal, digest } from "./retained-repair-test-support.mjs";
import { ready, toStartIntent, lifecycle, prepared, invoke } from "./retained-repair-lifecycle-test-support.mjs";
import { prepareRewriteFixture } from "./retained-repair-rewrite-test-support.mjs";

const sid = "synthetic-generation", key = "agent:controller-test-agent:existing";
function write(f, sql) {
  const db = new DatabaseSync(f.agentDatabasePath);
  try { db.exec(sql); } finally { db.close(); }
}
function rewrite(f, at = Date.parse(f.record.createdAt) + 1) {
  write(f, "ALTER TABLE transcript_rewrite_watermarks ADD COLUMN updated_at INTEGER");
  const db = new DatabaseSync(f.agentDatabasePath);
  try { db.prepare("UPDATE transcript_rewrite_watermarks SET generation=?,updated_at=? WHERE session_id=?").run("candidate-rewrite", at, sid); }
  finally { db.close(); }
}
function point(path, target) { unlinkSync(path); symlinkSync(target, path); }

test("retained fix-forward carries 36 post-journal rewrites, 5 rotations and 411 native deletions through target selection", t => {
  const f = ready(t), shape = prepareRewriteFixture(f);
  shape.evolve();
  const original = readFileSync(f.originalPath), agent = readFileSync(f.agentDatabasePath);
  const state = toStartIntent(f);
  assert.equal(state.record.phase, "REPAIR_START_INTENT");
  assert.equal(lifecycle(f, "inspect", state).record.phase, "REPAIR_START_INTENT");
  assert.deepEqual(readFileSync(f.originalPath), original);
  assert.deepEqual(readFileSync(f.agentDatabasePath), agent);
  // An accepted generation remains protected when its window becomes historical.
  write(f, `INSERT INTO session_windows VALUES ('later-current','${key}');
    INSERT INTO transcript_rewrite_watermarks VALUES ('later-current','later-token',${Date.now()});
    UPDATE session_nodes SET current_session_id='later-current',entry_json='{"sessionId":"later-current","updatedAt":4}',updated_at=4 WHERE session_key='${key}'`);
  assert.equal(lifecycle(f, "inspect", state).record.phase, "REPAIR_START_INTENT");
  // The accepted generation is carried forward, never a new rewrite by C.
  write(f, `UPDATE transcript_rewrite_watermarks SET generation='target-rewrite',updated_at=${Date.now()} WHERE session_id='${sid}'`);
  const refused = invoke(f, "retained-repair-lifecycle", "inspect", { journal: state.journal });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /strict original and current transcript continuity/);
});

for (const [label, change, pattern = /strict original and current transcript continuity/] of [
  ["watermark before journal", f => write(f, "UPDATE transcript_rewrite_watermarks SET updated_at=1")],
  ["watermark at journal", f => write(f, `UPDATE transcript_rewrite_watermarks SET updated_at=${Date.parse(f.record.createdAt)}`)],
  ["future watermark", f => write(f, "UPDATE transcript_rewrite_watermarks SET updated_at=9007199254740991")],
  ["missing watermark time", f => write(f, "UPDATE transcript_rewrite_watermarks SET updated_at=NULL")],
  ["noninteger watermark time", f => write(f, "UPDATE transcript_rewrite_watermarks SET updated_at=1794045249931.5")],
  ["missing journal time", f => journal(f, r => delete r.createdAt)],
  ["missing node", f => write(f, "DELETE FROM session_nodes")],
  ["missing window", f => write(f, "DELETE FROM session_windows")],
  ["missing watermark", f => write(f, "DELETE FROM transcript_rewrite_watermarks")],
  ["changed window owner", f => write(f, "UPDATE session_windows SET session_key='foreign'")],
  ["changed current session", f => write(f, "UPDATE session_nodes SET current_session_id='different'")],
  ["replaced database", f => replace(f.agentDatabasePath, readFileSync(f.agentDatabasePath)), /physical|identity|continuity/],
  ["predecessor pointer", f => point(join(f.serving, "current"), f.initial), /pointer/],
  ["predecessor process cwd", f => point(join(f.root, "proc", String(f.pid), "cwd"), f.initial), /candidate process/],
  ["native restore owner", f => journal(f, r => { r.nativeUpdate = {}; }), /native|journal|activation/],
]) test("post-journal rewrite refuses " + label, t => {
  const f = fixture(t);
  rewrite(f); change(f);
  const before = readFileSync(f.journal), result = call(f, "snapshot", f.request);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
  assert.deepEqual(readFileSync(f.journal), before);
});

test("a fresh preparation floor remains strict after accepting the original rewrite", t => {
  const f = fixture(t); rewrite(f);
  const snapshot = success(f, "snapshot", f.request), sealed = success(f, "seal", snapshot);
  assert.deepEqual(success(f, "check", snapshot), sealed);
  write(f, `UPDATE transcript_rewrite_watermarks SET generation='later-rewrite',updated_at=${Date.now()}`);
  const result = call(f, "check", snapshot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /strict original and current transcript continuity/);
  untouched(f);
});

test("a pre-journal rewrite accepted through its archive cannot lose that archive after sealing", t => {
  const f = ready(t); rewrite(f, 1);
  const blob = Buffer.from("synthetic original archive"), db = new DatabaseSync(f.agentDatabasePath);
  db.prepare("INSERT INTO session_transcript_archives VALUES (?,?,?,?,?,?)").run(sid, "generation-one", key, blob, digest(blob), "identity");
  db.close();
  const state = prepared(f);
  write(f, "DELETE FROM session_transcript_archives");
  const result = invoke(f, "retained-repair-lifecycle", "inspect", { journal: state.journal });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /strict original and current transcript continuity/);
});
