import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

// Five native writes across two old Gateway PIDs; the live generation is newer.
// Link three replaces identical bytes, so hash-only continuity cannot prove it.
function configChain(f, count = 5) {
  reconcileConfig(f);
  const db = new DatabaseSync(f.databasePath);
  const row = db.prepare("SELECT payload_json FROM diagnostic_events").get();
  const value = JSON.parse(row.payload_json);
  const times = ["09:55:40.169", "10:01:25.340", "15:23:28.787", "17:03:55.186", "21:57:44.349"];
  const rows = [];
  for (let i = 0; i < count; i++) {
    if (i) {
      const bytes = readFileSync(f.config);
      copyFileSync(f.config, f.config + ".bak"); chmodSync(f.config + ".bak", 0o600);
      replace(f.config, i === 2 ? bytes : Buffer.concat([bytes, Buffer.from(" ")]));
      const after = descriptor(f.config);
      for (const key of ["Hash", "Bytes", "Dev", "Ino", "Mode", "Nlink", "Uid", "Gid"])
        value["previous" + key] = value["next" + key];
      Object.assign(value, { nextHash: after.sha256, nextBytes: readFileSync(f.config).length,
        nextDev: String(after.device), nextIno: String(after.inode) });
    }
    value.ts = times[i] ? `2026-01-02T${times[i]}Z` : new Date(Date.parse("2026-01-02T22:00:00Z") + i * 1000).toISOString();
    value.pid = i < 2 ? 108735 : 1247959;
    rows.push({ ...value });
  }
  db.exec("DELETE FROM diagnostic_events");
  for (const [index, audit] of rows.entries()) {
    db.prepare("INSERT INTO diagnostic_events VALUES('config-audit',?,?,?)")
      .run(`${audit.ts}:config.write:fixture-${index}`, index * 2 + 1, JSON.stringify(audit));
    if (index === 2) db.prepare("INSERT INTO diagnostic_events VALUES('config-audit',?,?,?)")
      .run(`${audit.ts}:config.observe:read`, index * 2 + 2, JSON.stringify({ ts: audit.ts, source: "config-io",
        event: "config.observe", phase: "read", configPath: f.config, restoredFromBackup: false }));
  }
  db.close();
  return { rows, configSha256: descriptor(f.config).sha256 };
}

for (const count of [5, 64]) test(`retained repair prepares a contiguous ${count}-link native config chain`, t => {
  const f = ready(t), chain = configChain(f, count);
  f.request = build(f, "request", binding(f, chain.configSha256));
  const prepared = build(f, "begin", f.request);
  assert.equal(prepared.phase, "BUILD_PREPARED");
  untouched(f);
});

for (const [label, change, count = 5] of [
  ["gap", rows => rows.splice(2, 1)],
  ["fork", rows => rows.splice(2, 0, { ...rows[1], nextIno: "999" })],
  ["foreign source", rows => { rows[2].source = "foreign"; }],
  ["foreign scope", rows => { rows[2].scope = "foreign"; }],
  ["wrong backup", (_rows, f) => { writeFileSync(f.config + ".bak", readFileSync(f.config)); }],
  ["future timestamp", rows => { rows[4].ts = new Date(Date.now() + 60000).toISOString(); }],
  ["non-rename", rows => { rows[2].result = "write"; }],
  ["out-of-order timestamp", rows => { rows[2].ts = rows[0].ts; }],
  ["out-of-order sequence", rows => { [rows[1], rows[2]] = [rows[2], rows[1]]; }],
  ["foreign release", rows => { rows[2].cwd += "-foreign"; }],
  ["foreign writer", rows => { rows[2].argv = ["node", "/foreign/tool.js", "gateway"]; }],
  ["CLI writer", rows => { rows[2].argv = [...rows[2].argv.slice(0, 2), "config", "set"]; }],
  ["pre-journal timestamp", rows => { rows[0].ts = "2025-12-31T23:59:59Z"; }],
  ["changed intermediate inode", rows => { rows[2].nextIno = "999"; }],
  ["changed intermediate hash", rows => { rows[2].previousHash = "0".repeat(64); }],
  ["unsafe intermediate metadata", rows => { rows[2].nextMode = 0o644; }],
  ["chain limit", () => {}, 65],
]) test(`retained config chain refuses ${label} before preparation`, t => {
  const f = ready(t), chain = configChain(f, count);
  change(chain.rows, f);
  const db = new DatabaseSync(f.databasePath);
  db.exec("DELETE FROM diagnostic_events");
  for (const [index, audit] of chain.rows.entries())
    db.prepare("INSERT INTO diagnostic_events VALUES(?,?,?,?)")
      .run(audit.scope ?? "config-audit", `${audit.ts}:config.write:fixture-${index}`, index + 1, JSON.stringify(audit));
  db.close();
  const request = build(f, "request", binding(f, chain.configSha256));
  const result = invoke(f, "retained-repair-build", "begin", request);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native runtime-owner atomic replacement audit/);
  assert.equal(existsSync(f.prefix + ".build-intent.json"), false);
  untouched(f);
});
