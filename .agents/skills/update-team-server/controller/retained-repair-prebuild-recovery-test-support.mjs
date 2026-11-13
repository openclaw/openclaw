import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ready, build, invoke, descriptor, git, addSession, digest } from "./retained-repair-lifecycle-test-support.mjs";
import { prepareRewriteFixture } from "./retained-repair-rewrite-test-support.mjs";
import { retirementFixture, retire } from "./retained-repair-build-retirement-test-support.mjs";

export function twoIntentFixture(t, f = ready(t)) {
  addSession(f, "later-rewrite");
  const shape = prepareRewriteFixture(f), deleted = new DatabaseSync(shape.deletedDatabasePath);
  for (const encoded of f.witness) {
    const tuple = JSON.parse(encoded);
    if (tuple[1] !== shape.deletedDatabasePath) continue;
    const blob = Buffer.from("synthetic archived original " + tuple[5]);
    deleted.prepare("INSERT INTO session_transcript_archives VALUES (?,?,?,?,?,?)")
      .run(tuple[5], tuple[7], tuple[6], blob, digest(blob), "identity");
  }
  deleted.close();
  shape.evolve();
  const shared = new DatabaseSync(f.databasePath);
  shared.prepare("UPDATE agent_deletion_journal SET created_at=?").run(Date.parse(f.record.createdAt) - 1000);
  shared.close();
  const target = git(f.mirror, "commit-tree", git(f.mirror, "rev-parse", f.request.target.sha + "^{tree}"), "-p", f.request.target.sha, "-m", "advanced official main");
  f.addRelease(target);
  retirementFixture(t, f);
  const first = { operation: f.operation, intent: f.retirementRequest.buildIntent };
  git(f.mirror, "update-ref", "refs/remotes/origin/main", target);
  const stale = invoke(f, "retained-repair-build", "origin", first.operation);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /exact freshly frozen official main/);
  // This is a second rewrite of one of the original 36 sessions. The changed
  // tuple count stays 36; it invalidates the older operation's captured floor.
  const live = new DatabaseSync(f.agentDatabasePath);
  live.prepare("UPDATE transcript_rewrite_watermarks SET generation=?,updated_at=? WHERE session_id=?")
    .run("later-candidate-rewrite", Date.now(), "synthetic-generation");
  live.close();
  const beforeAdoption = retire(f, "inspect-build");
  const installed = f.library;
  f.library = f.retirementRunner;
  const prepared = invoke(f, "retained-controller-adoption", "prepare", f.retirementRequest.adoption);
  assert.equal(prepared.status, 0, prepared.stderr);
  const adopted = invoke(f, "retained-controller-adoption", "apply", JSON.parse(prepared.stdout));
  assert.equal(adopted.status, 0, adopted.stderr);
  f.library = installed;
  const request = build(f, "request", { operation: randomUUID(), target: "main", frozenMain: target,
    current: f.record.candidate.sha, pid: f.pid, generation: f.start, journalSha256: descriptor(f.journal).sha256 });
  const prefix = join(f.serving, "journal", "repair-" + request.operation);
  // A real SQLite rewrite after durable witness publication reproduces the
  // reported three-file/no-origin state without modifying controller artifacts.
  const preload = join(f.root, "rewrite-after-witness.mjs");
  writeFileSync(preload, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; import { DatabaseSync } from "node:sqlite";
const original = fs.linkSync; fs.linkSync = (from, to) => { const result = original(from, to); if (to === ${JSON.stringify(prefix + ".build-witness.json")}) { const db = new DatabaseSync(${JSON.stringify(f.agentDatabasePath)}); db.prepare("UPDATE transcript_rewrite_watermarks SET generation=?,updated_at=? WHERE session_id=?").run("rewrite-37",Date.now(),"session-later-rewrite"); db.close(); } return result; }; syncBuiltinESMExports();`);
  const changed = invoke(f, "retained-repair-build", "begin", request, preload);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /strict original and current transcript continuity/);
  f.retirementRequest.adoption = { ...f.retirementRequest.adoption, operation: randomUUID(), oldClosure: JSON.parse(adopted.stdout).closure };
  const second = { operation: { operation: request.operation }, intent: descriptor(prefix + ".build-intent.json") };
  const slots = [first, second].map(slot => ({ ...slot,
    request: { ...f.retirementRequest, buildIntent: slot.intent },
    files: ["build-intent", "build-original", "build-witness"].map(suffix => {
      const path = join(f.serving, "journal", "repair-" + slot.operation.operation + "." + suffix + ".json");
      return { path, descriptor: descriptor(path), bytes: readFileSync(path) };
    }) }));
  return { f, target, slots, beforeAdoption, changed };
}
