import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, ready, build, transaction, lifecycle, invoke, descriptor } from "./retained-repair-lifecycle-test-support.mjs";
import { reconcileConfig, untouched, replace } from "./retained-repair-test-support.mjs";

function binding(f, configSha256) {
  return { operation: f.request.operation, target: f.request.target.sha, current: f.record.candidate.sha,
    pid: f.pid, generation: f.start, journalSha256: f.request.source.sha256, configSha256 };
}

test("retained repair carries reviewed config through build and archived-journal activation", t => {
  const f = ready(t), configSha256 = reconcileConfig(f);
  const unreviewed = invoke(f, "retained-repair-build", "begin", f.request);
  assert.notEqual(unreviewed.status, 0);
  assert.match(unreviewed.stderr, /recovery protected path identity changed/);
  f.request = build(f, "request", binding(f, configSha256));
  build(f, "begin", f.request);
  build(f, "origin");
  const completed = build(f, "finish");
  const prepared = JSON.parse(readFileSync(completed.preparation.path));
  assert.equal(prepared.evidence.configReconciliation.config.sha256, configSha256);
  assert.equal(prepared.evidence.configReconciliation.journalSha256, f.request.source.sha256);
  untouched(f);
  const begun = transaction(f, "begin", completed.completed);
  const verified = transaction(f, "verify", begun.journal);
  const bound = lifecycle(f, "bind", verified, { instance: "fixture-original-instance" });
  assert.equal(bound.record.phase, "REPAIR_BOUND");
  assert.equal(lifecycle(f, "inspect", bound).record.phase, "REPAIR_BOUND");
  assert.deepEqual(readFileSync(JSON.parse(readFileSync(completed.completed.path)).original.path), f.original);
  assert.equal(descriptor(f.config).sha256, configSha256);
  const premature = invoke(f, "retained-repair-lifecycle", "complete", { journal: bound.journal });
  assert.notEqual(premature.status, 0, "target acceptance remains mandatory");
  writeFileSync(f.config, readFileSync(f.config, "utf8") + " ");
  assert.notEqual(invoke(f, "retained-repair-lifecycle", "inspect", { journal: bound.journal }).status, 0);
});

for (const [label, change, pattern] of [
  ["wrong config hash", (f, input) => { input.configSha256 = "0".repeat(64); }, /reviewed reconciliation config bytes changed/],
  ["wrong journal hash", (f, input) => { input.journalSha256 = "0".repeat(64); }, /incident binding changed/],
  ["changed generation", (f, input) => { input.generation = "9999"; }, /process generation changed/],
  ["replaced store", f => replace(f.databasePath, readFileSync(f.databasePath)), /refuses a replaced store/],
  ["missing audit", f => { const db = new DatabaseSync(f.databasePath); db.exec("DELETE FROM diagnostic_events"); db.close(); }, /lacks a native runtime-owner atomic replacement audit/],
]) test(`retained config reconciliation refuses ${label} before preparation`, t => {
  const f = ready(t), input = binding(f, reconcileConfig(f));
  change(f, input);
  let result = invoke(f, "retained-repair-build", "request", input);
  if (result.status === 0) result = invoke(f, "retained-repair-build", "begin", JSON.parse(result.stdout));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  untouched(f);
});
