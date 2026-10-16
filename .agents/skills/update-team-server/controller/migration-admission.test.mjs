import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

const library = new URL("./release-lib.mjs", import.meta.url).pathname;

function fixture(t) {
  const f = makeReleaseFixture(t), candidate = f.addRelease("b".repeat(40));
  const run = (command, args = [], input) => spawnSync(process.execPath, [library, command, ...args.map(String)],
    { env: f.env, input, encoding: "utf8", timeout: 10_000 });
  const ok = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  for (const [release, agent] of [[f.initial, 25], [candidate, 26]]) {
    const file = join(release, "package.json");
    chmodSync(file, 0o644);
    const pkg = JSON.parse(readFileSync(file));
    pkg.openclaw.schemaVersions = { state: 20, agent };
    writeFileSync(file, JSON.stringify(pkg));
    chmodSync(file, 0o444);
  }
  const shared = new DatabaseSync(f.databasePath);
  shared.exec("PRAGMA user_version=20"); shared.close();
  const agent = new DatabaseSync(f.agentDatabasePath);
  agent.exec("PRAGMA user_version=25; UPDATE schema_meta SET schema_version=25"); agent.close();
  const before = { sha: f.sha, schemaVersions: { state: 20, agent: 25 } };
  const after = { sha: "b".repeat(40), schemaVersions: { state: 20, agent: 26 } };
  const backupRoot = join(f.runtime, ".openclaw-update", `update-${after.sha}-11111111-1111-4111-8111-111111111111`, "native");
  const protectedPaths = JSON.parse(ok(run("fingerprint", [f.config, f.databasePath])));
  const witness = ok(run("session-preservation-witness", [f.initial, candidate, f.databasePath]));
  const create = () => run("journal-create", [f.journal, JSON.stringify(before), JSON.stringify(after), "system", 111, 1110,
    "fixture-instance", JSON.stringify(protectedPaths), before.sha, "absent", "enabled", "active", "disabled", "inactive",
    "fixture-suspension", Date.now() + 60_000, "READY", "@stdin", "", backupRoot], witness);
  const read = () => JSON.parse(ok(run("journal-read", [f.journal])));
  return { ...f, candidate, run, ok, before, after, backupRoot, witness, protectedPaths, create, read };
}

test("25 to 26 crosses the ordinary activation boundary and delegates migration support", t => {
  const f = fixture(t);
  assert.equal(f.ok(f.run("migration-kind", [JSON.stringify(f.before), JSON.stringify(f.after)])), "native-update");
  const shared = new DatabaseSync(f.databasePath);
  shared.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT, schema_version INTEGER)");
  shared.prepare("INSERT INTO agent_databases VALUES (?, ?, 24)").run("controller-test-agent", f.agentDatabasePath);
  shared.close();
  // The physical version and owner are authoritative; the registry may lag Doctor's commit.
  assert.equal(f.ok(f.run("compatibility", [f.initial, f.candidate, f.databasePath])).includes('"agentDatabases":1'), true);
  assert.equal(f.ok(f.create()), "A_PREPARED");
  const record = f.read();
  assert.deepEqual(record.nativeUpdate, { backupRoot: f.backupRoot });
  assert.equal(record.agentMigration, undefined);
  assert.equal(f.ok(f.run("journal-original-witness", [f.journal, JSON.stringify(record)])), f.witness);
  // The controller does not need a release-specific qualification even for later forward versions.
  const future = { ...f.after, schemaVersions: { state: 25, agent: 42 } };
  assert.equal(f.ok(f.run("migration-kind", [JSON.stringify(f.before), JSON.stringify(future)])), "native-update");
});

test("native restoration rebinds replaced files while retaining the original session witness", t => {
  const f = fixture(t); f.ok(f.create());
  const original = f.read(), originalWitness = readFileSync(join(dirname(f.journal), original.originalWitness.name));
  mkdirSync(dirname(f.backupRoot), { recursive: true, mode: 0o700 });
  for (const path of [f.config, f.databasePath, f.agentDatabasePath]) {
    copyFileSync(path, `${path}.restored`); chmodSync(`${path}.restored`, 0o600); renameSync(`${path}.restored`, path);
  }
  const identity = path => { const info = statSync(path); return { dev: info.dev, ino: info.ino }; };
  const receipt = { schemaVersion: 1, status: "restored", configPath: f.config,
    stateDir: dirname(dirname(f.databasePath)), databases: [f.databasePath, f.agentDatabasePath],
    databaseIdentities: Object.fromEntries([f.databasePath, f.agentDatabasePath].map(path => [path, identity(path)])),
    configIdentity: { path: f.config, ...identity(f.config) } };
  const receiptPath = `${f.backupRoot}.receipt.json`;
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const rebound = JSON.parse(f.ok(f.run("journal-native-state", [f.journal, JSON.stringify(original), f.config, f.databasePath])));
  assert.notEqual(rebound.protectedPaths[1].inode, original.protectedPaths[1].inode);
  assert.deepEqual(readFileSync(join(dirname(f.journal), original.originalWitness.name)), originalWitness);
  const projected = f.ok(f.run("journal-original-witness", [f.journal, JSON.stringify(rebound)]));
  f.ok(f.run("session-preservation-verify", [f.initial, f.initial, f.databasePath], projected));
  const saved = readFileSync(f.journal);
  receipt.databaseIdentities[f.databasePath].ino++;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.notEqual(f.run("journal-native-state", [f.journal, JSON.stringify(rebound), f.config, f.databasePath]).status, 0);
  assert.deepEqual(readFileSync(f.journal), saved);
});


test("native start permit stays revoked until the selected release matches the completed owner receipt", t => {
  const f = fixture(t); f.ok(f.create());
  const record = f.read();
  const permit = action => f.run("journal-native-permit", [f.journal, JSON.stringify(record), action]);
  f.ok(permit("revoke"));
  assert.equal(existsSync(f.permit), false);
  f.ok(permit("publish")); // No native receipt means no migration effect occurred.
  f.ok(permit("revoke"));
  mkdirSync(dirname(f.backupRoot), { recursive: true, mode: 0o700 });
  const identity = path => { const info = statSync(path); return { dev: info.dev, ino: info.ino }; };
  const receipt = { schemaVersion: 1, status: "backed-up", configPath: f.config,
    stateDir: dirname(dirname(f.databasePath)), databases: [f.databasePath],
    databaseIdentities: { [f.databasePath]: identity(f.databasePath) },
    configIdentity: { path: f.config, ...identity(f.config) } };
  const save = () => writeFileSync(`${f.backupRoot}.receipt.json`, JSON.stringify(receipt), { mode: 0o600 });
  const select = release => { unlinkSync(join(f.serving, "current")); symlinkSync(release, join(f.serving, "current")); };
  save();
  assert.notEqual(permit("publish").status, 0);
  assert.equal(existsSync(f.permit), false);
  receipt.status = "migrated"; save();
  assert.notEqual(permit("publish").status, 0, "old reader cannot start after migration");
  select(f.candidate);
  f.ok(permit("publish"));
  f.ok(permit("revoke"));
  for (const status of ["failed", "restoring-config"]) {
    receipt.status = status; save();
    assert.notEqual(permit("publish").status, 0);
    assert.equal(f.ok(f.run("journal-original-witness", [f.journal, JSON.stringify(record)])), f.witness);
    assert.equal(existsSync(f.permit), false);
  }
  receipt.status = "restored"; save();
  assert.notEqual(permit("publish").status, 0, "candidate cannot start on restored predecessor stores");
  select(f.initial);
  f.ok(permit("publish"));
  assert.equal(existsSync(f.permit), true);
});
