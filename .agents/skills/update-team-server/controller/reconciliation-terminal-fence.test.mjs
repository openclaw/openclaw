import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const physical = pathname => {
  const entry = lstatSync(pathname);
  return { device: entry.dev, inode: entry.ino };
};

function proof(fixture, args, input) {
  const result = spawnSync(process.execPath, ["--no-warnings", fixture.library, ...args], {
    encoding: "utf8", env: fixture.env, input, timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function reconciliationFixture(t) {
  const f = makeReleaseFixture(t);
  const candidateSha = "b".repeat(40), previousSha = "c".repeat(40);
  const candidatePath = f.addRelease(candidateSha);
  symlinkSync(f.addRelease(previousSha), join(f.serving, "previous"));
  const database = new DatabaseSync(f.databasePath);
  database.exec("CREATE TABLE schema_meta (meta_key TEXT, role TEXT, schema_version INTEGER, agent_id TEXT); INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL)");
  database.close();
  const predecessor = proof(f, ["validate-release", f.initial, f.sha, String(process.getuid()), "sealed"]);
  const candidate = proof(f, ["validate-release", candidatePath, candidateSha, String(process.getuid()), "sealed"]);
  const originalWitness = proof(f, ["session-preservation-witness", f.initial, f.initial, f.databasePath]);
  proof(f, ["journal-create", f.journal, predecessor, candidate, "system", "99", "990", "fixture-original-instance",
    proof(f, ["fingerprint", f.configPath, f.databasePath]), f.sha, previousSha,
    "enabled", "active", "disabled", "inactive", "12345678-1234-4234-8234-123456789abc",
    String(Date.now() + 60_000), "ready", "@stdin"], originalWitness);
  proof(f, ["journal-phase", f.journal, "ROLLBACK_FAILED"]);
  const config = JSON.parse(readFileSync(f.configPath));
  config.tools.media = { audio: { language: "en" } };
  writeFileSync(f.configPath + ".new", JSON.stringify(config) + "\n", { mode: 0o600 });
  renameSync(f.configPath + ".new", f.configPath);
  f.configBytes = readFileSync(f.configPath);
  f.journalBytes = readFileSync(f.journal);
  f.journalIdentity = physical(f.journal);
  const record = JSON.parse(f.journalBytes);
  f.witnessPath = join(f.serving, "journal", record.originalWitness.name);
  f.witnessBytes = readFileSync(f.witnessPath);
  f.request = { config: { path: f.configPath, sha256: digest(f.configBytes) },
    databasePath: f.databasePath, journalSha256: digest(f.journalBytes), runtimeUid: f.runtimeUid, startStopped: true };
  f.evidence = proof(f, ["recovery-snapshot", f.journal, f.serving, f.journalBytes.toString(), "restored", JSON.stringify(f.request)]);
  return f;
}

test("unchanged stopped reconciliation evidence may retire its exact journal", t => {
  const f = reconciliationFixture(t);
  assert.equal(proof(f, ["recovery-finish", f.journal, f.evidence, f.serving, "restored"]), "OK");
  assert.equal(existsSync(f.journal), false);
  assert.deepEqual(readFileSync(f.configPath), f.configBytes);
  assert.deepEqual(readFileSync(f.witnessPath), f.witnessBytes);
});

for (const target of ["config", "journal"]) test(`${target} replacement during final database validation refuses journal retirement`, t => {
  const f = reconciliationFixture(t);
  const mutation = join(f.root, "terminal-mutation.json");
  const preload = join(f.root, "replace-during-compatibility.mjs");
  const databaseIdentity = physical(f.databasePath), agentIdentity = physical(f.agentDatabasePath);
  // Intercept a real SQLite read after recoveryEvidence has read the bound config.
  // The mutation uses an exclusive same-directory file and atomic rename, without a production seam.
  writeFileSync(preload, `import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const target = ${JSON.stringify(target)}, targetPath = ${JSON.stringify(target === "config" ? f.configPath : f.journal)}, mutationPath = ${JSON.stringify(mutation)};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const physical = path => { const entry = lstatSync(path); return { device: entry.dev, inode: entry.ino }; };
const prepare = DatabaseSync.prototype.prepare;
let mutated = false;
DatabaseSync.prototype.prepare = function(sql, ...args) {
  if (!mutated && sql === "PRAGMA user_version") {
    mutated = true;
    const original = readFileSync(targetPath), before = physical(targetPath);
    let replacement = original;
    if (target === "config") {
      const config = JSON.parse(original); config.tools.media.audio.language = "de";
      replacement = Buffer.from(JSON.stringify(config) + "\\n");
    }
    const temporary = targetPath + ".terminal-next-" + process.pid;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, replacement); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, targetPath);
    writeFileSync(mutationPath, JSON.stringify({ boundary: "SQLite PRAGMA user_version", target, before, after: physical(targetPath), beforeSha256: digest(original), afterSha256: digest(readFileSync(targetPath)) }), { mode: 0o600, flag: "wx" });
  }
  return prepare.call(this, sql, ...args);
};
`, { mode: 0o600 });
  const result = spawnSync(process.execPath, ["--no-warnings", "--import", preload, f.library,
    "recovery-finish", f.journal, f.evidence, f.serving, "restored"], {
    encoding: "utf8", env: f.env, timeout: 30_000,
  });
  assert.ifError(result.error);
  const observed = JSON.parse(readFileSync(mutation));
  assert.equal(observed.beforeSha256, target === "config" ? f.request.config.sha256 : f.request.journalSha256);
  if (target === "config") assert.notEqual(observed.afterSha256, observed.beforeSha256);
  else assert.equal(observed.afterSha256, observed.beforeSha256);
  assert.notEqual(observed.after.inode, observed.before.inode);
  assert.equal(observed.after.device, observed.before.device);
  assert.deepEqual(physical(f.databasePath), databaseIdentity);
  assert.deepEqual(physical(f.agentDatabasePath), agentIdentity);
  assert.deepEqual(readFileSync(f.witnessPath), f.witnessBytes);
  t.diagnostic(JSON.stringify({ librarySha256: digest(readFileSync(f.library)), ...observed,
    exitCode: result.status, stdout: result.stdout, stderr: result.stderr, journalPresent: existsSync(f.journal),
    originalJournalSha256: digest(f.journalBytes), originalJournalIdentity: f.journalIdentity,
    sharedDatabaseIdentity: databaseIdentity, agentDatabaseIdentity: agentIdentity }));
  assert.equal(existsSync(f.journal), true, `${target} drift during compatibility must retain the activation journal`);
  assert.notEqual(result.status, 0, `${target} drift must refuse retirement`);
  assert.match(result.stderr, target === "config" ? /reconciled config changed during recovery validation/ : /reconciliation journal changed during recovery validation/);
  assert.deepEqual(readFileSync(f.journal), f.journalBytes);
  assert.deepEqual(physical(f.journal), target === "config" ? f.journalIdentity : observed.after);
  if (target === "journal") assert.deepEqual(readFileSync(f.configPath), f.configBytes);
});
