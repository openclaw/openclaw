import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

function invoke(f, args, input, timeout = 10_000) {
  return spawnSync(process.execPath, ["--no-warnings", f.library, ...args.map(String)],
    { env: f.env, input, encoding: "utf8", timeout });
}
const ok = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
const proof = (f, args, input) => ok(invoke(f, args, input, 30_000));

function nativeReceipt(f, status, databases = [f.databasePath]) {
  const identity = path => { const { dev, ino } = statSync(path); return { dev, ino }; };
  const receipt = { schemaVersion: 1, status, configPath: f.config,
    stateDir: dirname(dirname(f.databasePath)), databases,
    databaseIdentities: Object.fromEntries(databases.map(path => [path, identity(path)])),
    configIdentity: { path: f.config, ...identity(f.config) } };
  mkdirSync(dirname(f.backupRoot), { recursive: true, mode: 0o700 });
  const save = () => writeFileSync(`${f.backupRoot}.receipt.json`, JSON.stringify(receipt), { mode: 0o600 });
  save();
  return { receipt, save };
}

function migrationFixture(t) {
  const f = makeReleaseFixture(t), candidate = f.addRelease("b".repeat(40));
  const run = (command, args, input) => invoke(f, [command, ...args], input);
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
  const f = migrationFixture(t);
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
  const future = { ...f.after, schemaVersions: { state: 25, agent: 42 } };
  assert.equal(f.ok(f.run("migration-kind", [JSON.stringify(f.before), JSON.stringify(future)])), "native-update");
});

test("native restoration rebinds replaced files while retaining the original session witness", t => {
  const f = migrationFixture(t); f.ok(f.create());
  const original = f.read(), originalWitness = readFileSync(join(dirname(f.journal), original.originalWitness.name));
  for (const path of [f.config, f.databasePath, f.agentDatabasePath]) {
    copyFileSync(path, `${path}.restored`); chmodSync(`${path}.restored`, 0o600); renameSync(`${path}.restored`, path);
  }
  const { receipt, save } = nativeReceipt(f, "restored", [f.databasePath, f.agentDatabasePath]);
  const rebound = JSON.parse(f.ok(f.run("journal-native-state", [f.journal, JSON.stringify(original), f.config, f.databasePath])));
  assert.notEqual(rebound.protectedPaths[1].inode, original.protectedPaths[1].inode);
  assert.deepEqual(readFileSync(join(dirname(f.journal), original.originalWitness.name)), originalWitness);
  const projected = f.ok(f.run("journal-original-witness", [f.journal, JSON.stringify(rebound)]));
  f.ok(f.run("session-preservation-verify", [f.initial, f.initial, f.databasePath], projected));
  const saved = readFileSync(f.journal);
  receipt.databaseIdentities[f.databasePath].ino++;
  save();
  assert.notEqual(f.run("journal-native-state", [f.journal, JSON.stringify(rebound), f.config, f.databasePath]).status, 0);
  assert.deepEqual(readFileSync(f.journal), saved);
});

test("native start permit stays revoked until the selected release matches the completed owner receipt", t => {
  const f = migrationFixture(t); f.ok(f.create());
  const record = f.read();
  const permit = action => f.run("journal-native-permit", [f.journal, JSON.stringify(record), action]);
  f.ok(permit("revoke"));
  assert.equal(existsSync(f.permit), false);
  f.ok(permit("publish")); // No native receipt means no migration effect occurred.
  f.ok(permit("revoke"));
  const { receipt, save } = nativeReceipt(f, "backed-up");
  const select = release => { unlinkSync(join(f.serving, "current")); symlinkSync(release, join(f.serving, "current")); };
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

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const physical = pathname => {
  const { dev: device, ino: inode } = lstatSync(pathname); return { device, inode };
};

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
  f.witnessPath = join(f.serving, "journal", JSON.parse(f.journalBytes).originalWitness.name);
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

for (const target of ["config", "journal"]) {
test(`${target} replacement during final database validation refuses journal retirement`, t => {
  const f = reconciliationFixture(t);
  const preload = join(f.root, "replace-during-compatibility.mjs");
  const targetPath = target === "config" ? f.configPath : f.journal;
  const before = physical(targetPath);
  const replacement = target === "config"
    ? JSON.stringify({ ...JSON.parse(f.configBytes), tools: { ...JSON.parse(f.configBytes).tools, media: { audio: { language: "de" } } } }) + "\n"
    : f.journalBytes.toString();
  const databaseIdentity = physical(f.databasePath), agentIdentity = physical(f.agentDatabasePath);
  // Intercept a real SQLite read after recoveryEvidence has read the bound config.
  writeFileSync(preload, `import { DatabaseSync } from "node:sqlite";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
const targetPath = ${JSON.stringify(targetPath)};
const prepare = DatabaseSync.prototype.prepare;
let mutated = false;
DatabaseSync.prototype.prepare = function(sql, ...args) {
  if (!mutated && sql === "PRAGMA user_version") {
    mutated = true;
    const temporary = targetPath + ".terminal-next-" + process.pid;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, ${JSON.stringify(replacement)}); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, targetPath);
  }
  return prepare.call(this, sql, ...args);
};
`, { mode: 0o600 });
  const result = spawnSync(process.execPath, ["--no-warnings", "--import", preload, f.library,
    "recovery-finish", f.journal, f.evidence, f.serving, "restored"], {
    encoding: "utf8", env: f.env, timeout: 30_000,
  });
  assert.ifError(result.error);
  const after = physical(targetPath);
  assert.equal(readFileSync(targetPath, "utf8"), replacement);
  assert.notEqual(after.inode, before.inode);
  assert.equal(after.device, before.device);
  assert.deepEqual(physical(f.databasePath), databaseIdentity);
  assert.deepEqual(physical(f.agentDatabasePath), agentIdentity);
  assert.deepEqual(readFileSync(f.witnessPath), f.witnessBytes);
  assert.notEqual(result.status, 0, `${target} drift must refuse retirement`);
  assert.match(result.stderr, target === "config" ? /reconciled config changed during recovery validation/ : /reconciliation journal changed during recovery validation/);
  assert.deepEqual(readFileSync(f.journal), f.journalBytes);
  assert.deepEqual(physical(f.journal), target === "config" ? f.journalIdentity : after);
  if (target === "journal") { assert.deepEqual(readFileSync(f.configPath), f.configBytes); }
});
}

const library = new URL("./release-lib.mjs", import.meta.url).pathname;
const profile = {
  channels: [["sample-channel", "sample-account"]],
  modelAgent: "sample-agent",
  policy: {
    mode: "full", workspaceOnly: true, updateAuto: false, clickclackCommandMenu: false,
    appServer: { mode: "yolo", approvalPolicy: "never", approvalsReviewer: "user",
      sandbox: "danger-full-access", defaultWorkspaceDir: "/srv/sample/workspace" },
  },
};
const channels = {
  channelAccounts: { "sample-channel": [{
    accountId: "sample-account", configured: true, enabled: true,
    running: true, connected: true, lifecycle: "ready", restartPending: false, lastError: null,
  }] },
  eventLoop: { degraded: false },
};

function invokePolicy(args, input, selected = profile) {
  const env = { ...process.env };
  env.OPENCLAW_TEAM_OPERATOR_PROFILE =
    typeof selected === "string" ? selected : JSON.stringify(selected);
  return spawnSync(process.execPath, ["--no-warnings", library, ...args], {
    env,
    input: input && JSON.stringify(input),
    encoding: "utf8",
    timeout: 10_000,
  });
}

function configFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "controller-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    update: { auto: { enabled: false } },
    channels: { clickclack: { commandMenu: false } },
    tools: { exec: { mode: "full" }, fs: { workspaceOnly: true } },
    plugins: { entries: { codex: { config: {
      appServer: { ...profile.policy.appServer, extra: "preserved" },
    } } } },
    agents: { entries: { "sample-agent": { model: "fixture/selected-model" } } },
  };
  const pathname = join(root, "config.json");
  const policy = (selected) => {
    writeFileSync(pathname, JSON.stringify(config));
    return invokePolicy(["policy", pathname], undefined, selected);
  };
  return { config, policy };
}

test("operator channels select configured account identities", () => {
  const result = invokePolicy(["channels", "@stdin"], channels);
  assert.equal(result.status, 0, result.stderr);
  const wrong = structuredClone(channels);
  wrong.channelAccounts["sample-channel"][0].accountId = "other-account";
  assert.notEqual(invokePolicy(["channels", "@stdin"], wrong).status, 0);
});

test("operator profile rejects missing, malformed, or unsafe expectations", () => {
  for (const selected of [
    "",
    "{",
    null,
    {},
    { ...profile, channels: [] },
    { ...profile, channels: [...profile.channels, ...profile.channels] },
    { ...profile, channels: [["sample-channel"]] },
    { ...profile, policy: { ...profile.policy, updateAuto: true } },
  ]) {
    assert.notEqual(invokePolicy(["channels", "@stdin"], channels, selected).status, 0);
  }
});

test("operator policy selects the configured model and enforces workspace and manual updates", (t) => {
  const fixture = configFixture(t);
  const result = fixture.policy();
  assert.equal(result.status, 0, result.stderr);
  const accepted = JSON.parse(result.stdout);
  assert.equal(accepted.appServer.defaultWorkspaceDir, "/srv/sample/workspace");
  assert.equal(accepted.appServer.extra, "preserved");
  fixture.config.plugins.entries.codex.config.appServer.defaultWorkspaceDir =
    "/srv/other/workspace";
  assert.notEqual(fixture.policy().status, 0);
  fixture.config.plugins.entries.codex.config.appServer.defaultWorkspaceDir = "/srv/sample/workspace";
  fixture.config.update.auto.enabled = true;
  assert.notEqual(fixture.policy().status, 0, "configuration cannot enable unattended updates");
});

test("operator policy captures only the selected model fallback policy", (t) => {
  const fixture = configFixture(t);
  assert.notEqual(fixture.policy({ ...profile, modelAgent: "other-agent" }).status, 0);
  fixture.config.agents.defaults = { model: { primary: "fixture/default", fallbacks: ["fixture/default-fallback"] } };
  for (const [model, expected] of [
    [undefined, ["fixture/default-fallback"]],
    ["fixture/selected-model", []],
    [{ primary: "fixture/selected-model" }, []],
    [{ primary: "fixture/selected-model", fallbacks: [] }, []],
    [{ primary: "fixture/selected-model", fallbacks: ["fixture/fallback"] }, ["fixture/fallback"]],
  ]) {
    fixture.config.agents.entries["sample-agent"].model = model;
    const result = fixture.policy();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).model, model === undefined ? "fixture/default" : "fixture/selected-model");
    assert.deepEqual(JSON.parse(result.stdout).fallbacks, expected);
  }
  for (const fallbacks of ["fixture/fallback", ["unqualified"], [null]]) {
    fixture.config.agents.entries["sample-agent"].model = { primary: "fixture/selected-model", fallbacks };
    const result = fixture.policy();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configured deployment model fallbacks are invalid/);
  }
});

const owner = readFileSync(process.env.TEAM_OWNER_TEST_SOURCE ?? new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const ownerLibrary = process.env.TEAM_OWNER_TEST_LIBRARY ?? join(import.meta.dirname, "release-lib.mjs");
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const fileHelper = owner.slice(owner.indexOf("user_file_systemctl() {"), owner.indexOf("user_unit_file() {"));
const helpers = owner.slice(owner.indexOf("system_state() {"), owner.indexOf("load_gateway_runtime() {") < 0 ? owner.indexOf("read_service() {") : owner.indexOf("load_gateway_runtime() {"));
const stoppedOwners = owner.match(/^stopped_system_owners\(\) \{[\s\S]*?^\}/m)[0];
const manager = { LoadState: "loaded", ActiveState: "inactive", SubState: "dead", MainPID: "0", ControlPID: "0", Job: "", ControlGroup: "" };

// Exercise the maintained admission boundary against native command outcomes.
// Unlike a boolean mock, unavailable D-Bus and offline disabled are distinct exits.
function admission(t, change = {}, topology = "system") {
  const root = mkdtempSync(join(tmpdir(), "team-user-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = { system: "active", user: "", userExit: 1, enabled: "disabled", manager, ...change };
  const systemctl = join(root, "systemctl");
  writeFileSync(systemctl, `#!${process.execPath}\nconst f=${JSON.stringify(fixture)};
const fs=require("node:fs");
const args=process.argv.slice(2), user=args.includes('--user'), offline=args.includes('--root=/');
if(args.includes('show')) {
 if(args.includes('openclaw-gateway.service')) {
  if(user&&!f.user)process.exit(f.userExit);
  const fields=user?{MainPID:f.userMainPID??'0',ControlPID:'0',Job:'0'}:
    {ActiveState:f.system,SubState:'dead',MainPID:'0',ControlPID:'0',Job:'0'};
  for(const [key,value] of Object.entries(fields))process.stdout.write(key+'='+value+'\\n');
  process.exit(0);
 }
 if(f.managerExit) process.exit(f.managerExit);
 if(f.managerChanges || f.managerRecheckFails) { const counter=__filename+'.reads'; const second=fs.existsSync(counter); if(second&&f.managerChanges) f.manager.ActiveState='active'; if(second&&f.managerRecheckFails) process.exitCode=1; fs.writeFileSync(counter,'1'); }
 if(!args.includes('user@1000.service')) process.exit(64);
 if(f.managerRaw !== undefined) process.stdout.write(f.managerRaw);
 else for(const [key,value] of Object.entries(f.manager)) process.stdout.write(key+'='+value+'\\n');
} else if(args.includes('is-active')) {
 process.stdout.write(user?f.user:f.system); process.exit(user?f.userExit:f.system==='active'?0:3);
} else if(args.includes('is-enabled')) {
 if(user&&!offline) { process.stdout.write(f.user ? f.enabled : ''); process.exit(f.user?f.enabled==='enabled'?0:1:1); }
 process.stdout.write(user?f.enabled:f.systemEnabled??'enabled'); process.exit(user?f.enabled==='enabled'?0:1:0);
} else process.exit(64);
`, { mode: 0o755 });
  mkdirSync(join(root, "sys/fs/cgroup/user.slice/user-1000.slice"), { recursive: true });
  if (change.events !== undefined) {
    const group = join(root, "sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service");
    mkdirSync(group);
    writeFileSync(join(group, "cgroup.events"), change.events);
  }
  const program = `set -euo pipefail
systemctl_bin=${quote(systemctl)}
node_bin=${quote(process.execPath)}
runtime_uid=1000
runtime_home=${quote(root)}
runtime_dir=${quote(join(root, 'run/user/1000'))}
bus_address="unix:path=$runtime_dir/bus"
ancestor_boundary=${quote(root)}
ss_bin=/usr/bin/true; gateway_port=18789
run_runtime() { "$@"; }
user_systemctl() { run_runtime "$systemctl_bin" --user "$@"; }
system_systemctl() { "$systemctl_bin" "$@"; }
proof() { "$node_bin" --no-warnings ${quote(ownerLibrary)} "$@"; }
fail() { printf '%s\\n' "$*" >&2; return 1; }
${fileHelper}
${helpers}
${stoppedOwners}
if ${topology === "stopped" ? "stopped_system_owners" : `assert_exclusive_owner ${quote(topology)}`}; then printf ADMITTED; else exit 1; fi
`;
  const result = spawnSync("bash", ["-c", program], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, OPENCLAW_TEAM_ROOT_UID: String(process.getuid()), OPENCLAW_TEAM_ROOT_GID: String(process.getgid()) } });
  assert.ifError(result.error);
  return result;
}

for (const [name, change] of [
  ...[
    { ActiveState: "active", SubState: "running", MainPID: "42" },
    { ActiveState: "activating", SubState: "start" },
    { MainPID: "42" }, { ControlPID: "43" }, { Job: "17" },
    { LoadState: "error" }, { SubState: "stop-sigterm" },
  ].map(mutation => [JSON.stringify(mutation), { manager: { ...manager, ...mutation } }]),
  ["manager command error", { managerExit: 1 }],
  ["manager changes during cgroup observation", { managerChanges: true }],
  ["failed recheck with identical output", { managerRecheckFails: true }],
  ["malformed user output", { user: "inactive\nactive", userExit: 3 }],
  ["empty successful user query", { user: "", userExit: 0 }],
  ["noncanonical manager group", { manager: { ...manager, ControlGroup: "/elsewhere" } }],
  ["space-only manager group", { manager: { ...manager, ControlGroup: " " } }],
  ["missing manager fields", { managerRaw: "ActiveState=inactive\n" }],
  ["duplicate manager fields", { managerRaw: Object.entries(manager).map(([k,v]) => `${k}=${v}\n`).join('') + "MainPID=0\n" }],
  ["populated manager descendants", { events: "populated 1\nfrozen 0\n" }],
  ["malformed cgroup state", { events: "populated unknown\n" }],
  ["still enabled legacy unit", { enabled: "enabled" }],
  ["missing legacy unit", { enabled: "not-found" }],
  ["malformed enablement", { enabled: "disabled\nenabled" }],
  ["active legacy Gateway", { user: "active", userExit: 0 }],
]) {
  test(`${name} refuses system ownership`, t => assert.notEqual(admission(t, change).status, 0));
}
for (const [name, topology, change, accepted] of [
  ["offline stopped manager", "system", {}, true],
  ["live inactive legacy Gateway", "system", { user: "inactive", userExit: 3 }, true],
  ["empty manager cgroup", "system", { events: "populated 0\nfrozen 0\n", manager: { ...manager, Job: "0", ControlGroup: "/user.slice/user-1000.slice/user@1000.service" } }, true],
  ["active legacy migration", "migration-user", { system: "inactive", systemEnabled: "disabled", user: "active", userExit: 0, enabled: "enabled" }, true],
  ["missing legacy migration", "migration-user", { system: "inactive", systemEnabled: "disabled" }, false],
  ["quiescent stopped manager", "quiescent", { system: "inactive" }, true],
  ["quiescent unknown manager", "quiescent", { system: "inactive", managerExit: 1 }, false],
  ["stopped offline manager", "stopped", { system: "inactive" }, true],
  ...[
    { manager: { ...manager, MainPID: "42" } }, { managerChanges: true },
    { events: "populated 1\nfrozen 0\n" }, { user: "inactive", userExit: 3, userMainPID: "42" },
  ].map(mutation => [JSON.stringify(mutation), "stopped", { system: "inactive", ...mutation }, false]),
]) {
  test(`${topology}: ${name}`, t => {
    const result = admission(t, change, topology);
    if (accepted) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "ADMITTED");
    } else {
      assert.notEqual(result.status, 0);
    }
  });
}
