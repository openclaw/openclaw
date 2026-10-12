import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";

const library = join(import.meta.dirname, "release-lib.mjs");
const originalUmask = process.umask(0o022);
after(() => process.umask(originalUmask));

function copyStore(source, destination) {
  fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  // cpSync mode preservation varies by Node version and inherited umask.
  // Model Doctor's preserved directory and regular-file modes explicitly.
  const directories = [[source, destination]];
  for (const [from, to] of directories) {
    fs.chmodSync(to, fs.statSync(from).mode & 0o7777);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push([join(from, entry.name), join(to, entry.name)]);
      else if (entry.isFile()) fs.chmodSync(join(to, entry.name), fs.statSync(join(from, entry.name)).mode & 0o7777);
    }
  }
}

function fixture(t, { auxiliary = false, beforePreflight, beforeCold, captureFailure = false, pauseRehearsal = false, pausePrepared = false, crossing = false, nocow = true, liveProbe = false, preexisting = true, fiveAgents = false } = {}) {
  const f = makeReleaseFixture(t), candidate = f.addRelease("b".repeat(40));
  const preload = join(f.root, "native-probes.mjs"), aclOverrides = join(f.root, "acl-overrides.json");
  fs.writeFileSync(aclOverrides, "{}", { mode: 0o600 });
  const filesystemOverrides = join(f.root, "filesystem-overrides.json");
  fs.writeFileSync(filesystemOverrides, "{}", { mode: 0o600 });
  // Unavailable OS probes and unprivileged symlink-owner drift are injected.
  // SQLite, backup, inode identity, journals and verification use real local files.
  fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const facts=p=>JSON.parse(fs.readFileSync(${JSON.stringify(filesystemOverrides)}))[p]??{};
const lstat=fs.lstatSync;
fs.lstatSync=(...a)=>{const entry=lstat(...a), overrides=facts(a[0]);return entry?.isSymbolicLink()?Object.assign(entry,overrides):entry;};
const spawn=cp.spawnSync;cp.spawnSync=(c,a,o)=>c==='getfacl'?{status:a[0]==='-cEpn'&&a[1]==='--'?0:1,stdout:JSON.parse(fs.readFileSync(${JSON.stringify(aclOverrides)}))[a.at(-1)]??'user::rw-\\ngroup::---\\nother::---\\n'}:c==='lsattr'?{status:!facts(a.at(-1)).unavailable&&a[0]==='-d'&&a[1]==='--'?0:1,stdout:(facts(a.at(-1)).flags??${JSON.stringify(preexisting ? "---------------C--" : "------------------")})+' '+a.at(-1)}:spawn(c,a,o);
const probe=cp.spawnSync;cp.spawnSync=(c,a,o)=>c==='getfacl'&&lstat(a.at(-1)).isSymbolicLink()?{status:1,stderr:'symlink ACL probe must not follow the target'}:probe(c,a,o);
const statfs=fs.statfsSync;fs.statfsSync=(...a)=>({...statfs(...a),type:facts(a[0]).type??0x9123683e,bavail:1000000000,bsize:4096});syncBuiltinESMExports();`);
  const liveCapture = join(f.root, "live-capture.json"), queries = join(f.root, "sqlite-queries.jsonl");
  let proofLibrary = library;
  if (liveProbe) {
    // Observe the real capture result without adding a production test API.
    const source = fs.readFileSync(library, "utf8"), driver = source.lastIndexOf("\ntry {\n");
    assert.ok(driver > 0);
    proofLibrary = join(f.root, "capture-probe.mjs");
    fs.writeFileSync(proofLibrary, source.slice(0, driver) + `
const capture = offlineCapture;
offlineCapture = (...args) => {
  const result = capture(...args);
  if (args[2]?.live) writeFileSync(${JSON.stringify(liveCapture)}, JSON.stringify(result));
  return result;
};
` + source.slice(driver));
    // Keep real SQLite locks, but shorten contention waits and observe executed SQL.
    fs.appendFileSync(preload, `
import {DatabaseSync} from 'node:sqlite';
const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.exec = function(sql) { return exec.call(this, sql.replace(/busy_timeout=30000/g, 'busy_timeout=20')); };
DatabaseSync.prototype.prepare = function(sql) {
  exec.call(this, 'PRAGMA busy_timeout=20');
  fs.appendFileSync(${JSON.stringify(queries)}, JSON.stringify({command:process.argv[2],sql})+'\\n');
  return prepare.call(this, sql);
};`);
  }
  const run = (cmd, args = [], input) => spawnSync(process.execPath, ["--no-warnings", "--import", preload, proofLibrary, cmd, ...args.map(String)], { env: f.env, encoding: "utf8", input, timeout: 30000 });
  const ok = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const proof = (cmd, args = [], input) => ok(run(cmd, args, input));
  const state = join(f.runtime, ".openclaw"), config = join(state, "openclaw.json"), shared = join(state, "state/openclaw.sqlite"), agent = join(state, "agents/controller-test-agent/agent/openclaw-agent.sqlite");
  const agentIds = fiveAgents ? ["controller-test-agent", "fixture-node", "claude", "codex", "openclaw"] : ["controller-test-agent"];
  const agents = agentIds.map(id => join(state, "agents", id, "agent/openclaw-agent.sqlite"));
  for (const p of [dirname(shared), ...agents.map(dirname), join(state, "workspace")]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  const nested = join(dirname(shared), "nested");
  fs.mkdirSync(nested, { mode: 0o750 });
  fs.writeFileSync(join(nested, "note"), "synthetic store entry", { mode: 0o640 });
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.config)), agents: { ...JSON.parse(fs.readFileSync(f.config)).agents, defaults: { ...JSON.parse(fs.readFileSync(f.config)).agents?.defaults, workspace: join(state, "workspace") }, entries: Object.fromEntries(agentIds.map(id => [id, {}])) } }), { mode: 0o600 });
  for (const [path, owner] of [[shared, null], ...agents.map((path, index) => [path, agentIds[index]])]) {
    const db = new DatabaseSync(path);
    const version = crossing ? owner ? 24 : 19 : 1;
    db.exec(`PRAGMA user_version=${version}; CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT,created_at INTEGER);`);
    db.prepare("INSERT INTO schema_meta VALUES('primary',?,?,?,1)").run(owner ? "agent" : "global", version, owner);
    if (!owner) {
      db.exec("CREATE TABLE agent_databases(agent_id TEXT,path TEXT,schema_version INTEGER); CREATE TABLE config_machine_state(state_key TEXT,value_json TEXT); CREATE TABLE plugin_state_entries(plugin_id TEXT,namespace TEXT,entry_key TEXT,value_json TEXT);");
      for (const [index, path] of agents.entries()) db.prepare("INSERT INTO agent_databases VALUES(?,?,?)").run(agentIds[index], path, crossing ? 24 : 1);
    } else db.exec("CREATE TABLE session_participants(session_key TEXT,identity_namespace TEXT,actor_id TEXT,contribution_count INTEGER,first_prompted_at INTEGER,last_prompted_at INTEGER); CREATE TABLE session_nodes(session_key TEXT,current_session_id TEXT); CREATE TABLE session_windows(session_key TEXT,session_id TEXT); CREATE TABLE transcript_rewrite_watermarks(session_id TEXT,generation TEXT); INSERT INTO session_nodes VALUES('agent:controller-test-agent:main','session'); INSERT INTO session_windows VALUES('agent:controller-test-agent:main','session'); INSERT INTO transcript_rewrite_watermarks VALUES('session','generation');");
    if (crossing && owner) {
      db.exec("CREATE UNIQUE INDEX session_windows_id ON session_windows(session_id)");
      db.exec(fs.readFileSync(new URL("./agent20-cold-schema.fixture.sql", import.meta.url), "utf8"));
    }
    db.close(); fs.chmodSync(path, 0o600);
  }
  const auxiliaryPaths = [join(dirname(shared), "openclaw-quarantine.sqlite"), join(dirname(shared), "coordination.sqlite"), join(dirname(agent), "worker-private.sqlite")];
  if (auxiliary) for (const path of auxiliaryPaths) {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE records(key TEXT PRIMARY KEY,value TEXT CHECK(value <> 'invalid')); INSERT INTO records VALUES('fixture','preserved');");
    db.close(); fs.chmodSync(path, 0o600);
  }
  const releases = [];
  for (const [path, sha] of [[f.initial, f.sha], [candidate, "b".repeat(40)]]) {
    fs.chmodSync(path, 0o755); fs.chmodSync(join(path, "node_modules"), 0o755);
    if (crossing) {
      fs.chmodSync(join(path, "package.json"), 0o644);
      fs.writeFileSync(join(path, "package.json"), JSON.stringify({ version: "2026.10.1", openclaw: { schemaVersions: { state: path === candidate ? 20 : 19, agent: 24 } } }));
      fs.mkdirSync(join(path, "src/state"), { recursive: true });
      fs.writeFileSync(join(path, "src/state/openclaw-agent-schema.sql"), fs.readFileSync(new URL("./agent20-cold-schema.fixture.sql", import.meta.url)));
    }
    fs.mkdirSync(join(path, "node_modules/sqlite-vec"));
    fs.writeFileSync(join(path, "node_modules/sqlite-vec/index.js"), "exports.load=db=>db.function('vec_version',()=> 'fixture');");
    proof("manifest", [path, sha, process.getuid(), sha]); proof("seal-tree", [path]);
    releases.push(JSON.parse(proof("validate-release", [path, sha, process.getuid(), "sealed"])));
  }
  const base = { version: 1, topology: "system", ...(nocow ? { offlineDoctor: true } : {}), predecessor: releases[0], candidate: releases[1],
    process: { pid: 111, generation: "1110", instance: "fixture-instance-111" }, suspension: null,
    services: { system: { unitFileState: "enabled", activeState: "active" }, user: { unitFileState: "disabled", activeState: "inactive" } },
    protectedPaths: JSON.parse(proof("fingerprint", [config, shared])), pointerTopology: { current: { present: true, sha: f.sha }, previous: { present: false, sha: null } } };
  let evidence = JSON.parse(proof("migration-create", [f.serving, "@stdin"], JSON.stringify(base)));
  const load = () => JSON.parse(proof("migration-load", [f.journal, f.serving]));
  const command = (cmd, args = []) => run(cmd, [f.journal, f.serving, JSON.stringify(load()), ...args]);
  beforePreflight?.({ shared, agent, auxiliaryPaths });
  if (nocow) evidence = JSON.parse(ok(command("offline-doctor-preflight", [config, shared])));
  const readLiveCapture = () => JSON.parse(fs.readFileSync(liveCapture, "utf8"));
  const readQueries = () => fs.readFileSync(queries, "utf8").trim().split("\n").map(row => JSON.parse(row));
  if (pauseRehearsal) return { ...f, config, shared, agent, auxiliaryPaths, readLiveCapture, readQueries };
  const record = evidence.record, stage = evidence.identity.stage.path;
  if (crossing) {
    assert.equal(record.agentMigration.artifacts.preflight, undefined, "NOCOW preflight cannot replace copied rehearsal");
    // Model only the completed warm rehearsal, as migration-forward-recovery.test.mjs does.
    const path = join(stage, `preflight-${randomUUID()}.json`);
    fs.writeFileSync(path, JSON.stringify({ version: 1, completeClosure: true, dataReady: true, candidate: base.candidate.sha,
      schemaProfile: { from: base.predecessor.schemaVersions, to: base.candidate.schemaVersions } }), { mode: 0o600 });
    const entry = fs.statSync(path);
    record.agentMigration.artifacts.preflight = { name: path.split("/").at(-1), device: entry.dev, inode: entry.ino,
      sha256: createHash("sha256").update(fs.readFileSync(path)).digest("hex") };
  }
  record.phase = "C_CURRENT_SELECTED"; record.suspension = { id: randomUUID(), expiresAtMs: Date.now() + 60000, terminalPolicy: "preserve", status: "ready" }; record.agentMigration.phase = "prepared";
  fs.writeFileSync(f.journal, JSON.stringify(record), { mode: 0o600 });
  fs.unlinkSync(join(f.serving, "current")); fs.symlinkSync(candidate, join(f.serving, "current")); fs.symlinkSync(f.initial, join(f.serving, "previous"));
  fs.unlinkSync(f.permit); fs.rmSync(f.env.OPENCLAW_TEAM_PROC_ROOT, { recursive: true }); fs.mkdirSync(f.env.OPENCLAW_TEAM_PROC_ROOT);
  const artifact = kind => JSON.parse(fs.readFileSync(join(stage, load().record.agentMigration.artifacts[kind].name)));
  const replaceArtifact = (kind, value) => {
    const record = load().record, descriptor = record.agentMigration.artifacts[kind], path = join(stage, descriptor.name);
    fs.writeFileSync(path, JSON.stringify(value));
    descriptor.sha256 = createHash("sha256").update(fs.readFileSync(path)).digest("hex");
    fs.writeFileSync(f.journal, JSON.stringify(record));
  };
  beforeCold?.({ shared, agent, auxiliaryPaths });
  // Cold capture and WAL-aware backup are the real migration owner, including its no-writer fence.
  ok(command("migration-cold-backup", [config, shared, f.env.OPENCLAW_TEAM_PROC_ROOT]));
  if (pausePrepared) return { ...f, candidate, config, shared, agent, auxiliaryPaths, filesystemOverrides, run, proof, ok, load, command, artifact, replaceArtifact };
  ok(run("migration-transition", [f.journal, f.serving, JSON.stringify(load()), "@stdin"], '{"phase":"doctor-started"}'));
  const captureResult = nocow ? command("offline-doctor-capture", [f.env.OPENCLAW_TEAM_PROC_ROOT]) : { status: 0, stdout: "" };
  if (captureFailure) {
    assert.notEqual(captureResult.status, 0);
    return { ...f, candidate, config, shared, agent, auxiliaryPaths, run, proof, ok, load, command, artifact, captureResult, readLiveCapture, readQueries };
  }
  ok(captureResult);
  const log = join(stage, "doctor-20260930T000000Z-123");
  if (nocow) ok(command("offline-doctor-intent", [log, f.env.OPENCLAW_TEAM_PROC_ROOT]));
  for (const suffix of nocow ? [".stdout", ".stderr"] : []) {
    assert.match(fs.readFileSync(log + suffix, "utf8"), /OPENCLAW_TEAM_DOCTOR_ATTEMPT .*"index":1/);
    assert.equal(fs.statSync(log + suffix).mode & 0o777, 0o600);
  }
  const verify = (exit = 0) => command("offline-doctor-verify", [exit, f.env.OPENCLAW_TEAM_PROC_ROOT]);
  const rewrite = (directory, receipt = true) => {
    const replacement = directory + ".nocow-backup-fixture", snapshots = directory + ".nocow-snapshots-fixture", temporary = directory + ".exchange";
    copyStore(directory, replacement); fs.mkdirSync(snapshots, { mode: 0o700 });
    // Simulate mv --exchange while preserving both directory inodes.
    fs.renameSync(directory, temporary); fs.renameSync(replacement, directory); fs.renameSync(temporary, replacement);
    const facts = JSON.parse(fs.readFileSync(filesystemOverrides));
    facts[directory] = { type: 0x9123683e, flags: "---------------C--" };
    fs.writeFileSync(filesystemOverrides, JSON.stringify(facts));
    const line = `Rewrote SQLite store directory with NOCOW: ${directory}. Original retained at ${replacement}; verified WAL-aware snapshots at ${snapshots}.`;
    if (receipt) fs.appendFileSync(log + ".stdout", line + "\n");
    return { replacement, snapshots, line };
  };
  return { ...f, candidate, config, shared, agent, agents, nested, auxiliaryPaths, aclOverrides, filesystemOverrides, run, proof, ok, load, command, artifact, replaceArtifact, log, verify, rewrite, readLiveCapture, readQueries };
}

function partialDoctor(f, { exit = 0, extra = "", complete = true, wrapped = false, crossing = true } = {}) {
  if (crossing) migrateShared(f);
  f.rewrite(dirname(f.shared));
  const messages = f.agents.map((path, index) => `SQLite NOCOW repair refused for ${dirname(path)}: Error: ${index === 0
    ? "fuser could not establish that all handles are closed: spawnSync fuser E2BIG; ensure fuser is installed and can inspect processes using this store. Original store remains in place."
    : "store files are open (pids: 1933569); stop processes using this store before retrying. Original store remains in place."}`);
  const text = messages.map(message => wrapped ? message.replace(/(NOCOW |repair |refused for |\/agents\/|; |closed: )/g, "$1\n")
    .split("\n").map(line => `│ ${line.trim()} │`).join("\n") : message).join("\n");
  fs.appendFileSync(f.log + ".stdout", `${complete ? "│  - Recorded cron completion delivery attempt uncertainty (v20)  │\n" : ""}${text}\n${extra}\n└  Doctor complete.\n`);
  assert.notEqual(f.verify(exit).status, 0);
}

function interruptedDoctor(f, { crossing = false, exit = 124, signal = true, extra = "" } = {}) {
  const rewrite = f.rewrite(dirname(f.agent), false);
  if (crossing) migrateShared(f);
  const claude = dirname(f.agents[2]), node = dirname(f.agents[1]);
  copyStore(claude, claude + ".nocow-backup-staging");
  fs.mkdirSync(claude + ".nocow-snapshots-staging");
  fs.mkdirSync(node + ".nocow-snapshots-staging");
  fs.appendFileSync(f.log + ".stderr", `${signal ? "Doctor interrupted by SIGTERM; cancelling inspections and settling admitted repairs before exit" : ""}\n${extra}\n`);
  if (exit !== null) assert.notEqual(f.verify(exit).status, 0);
  return rewrite;
}

for (const crossing of [false, true]) for (const exit of [124, null])
test(`filesystem-proven timeout exchange completes partial recovery (crossing=${crossing}, exit=${exit})`, t => {
  const f = fixture(t, { crossing, preexisting: false, fiveAgents: true, auxiliary: true, beforePreflight: codexWrappers });
  const rewrite = interruptedDoctor(f, { crossing, exit });
  const originals = Object.fromEntries(["inventory", "witness", "backups", "precapture", "nocow"].map(kind => [kind, f.artifact(kind)]));
  f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  const binding = f.artifact("rebinding"), byPath = new Map(binding.directories.map(row => [row.path, row]));
  assert.equal(byPath.get(dirname(f.agent)).nocow, "rewritten-unreceipted");
  assert.deepEqual(byPath.get(dirname(f.agent)).inferredReceipt, { backup: rewrite.replacement, snapshotRoot: rewrite.snapshots });
  assert.equal(byPath.get(dirname(f.agents[2])).nocow, "interrupted");
  assert.equal(byPath.get(dirname(f.agents[2])).retainedStaging.length, 2);
  assert.equal(byPath.get(dirname(f.agents[1])).nocow, "interrupted");
  assert.equal(byPath.get(dirname(f.agents[1])).retainedStaging.length, 1);
  for (const path of [f.shared, ...f.agents.slice(3)]) {
    assert.equal(byPath.get(dirname(path)).nocow, "preexisting");
    assert.equal(byPath.get(dirname(path)).nocowApplied, false);
  }
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(fs.existsSync(f.permit), true);
  for (const [kind, value] of Object.entries(originals)) assert.deepEqual(f.artifact(kind), value);
  for (const row of binding.directories) for (const path of row.retainedStaging ?? []) assert.equal(fs.existsSync(path), true);
  const summary = f.ok(f.command("migration-nocow-summary"));
  assert.match(summary, /nocow=partial refused=0 .*interrupted=2 rewritten-unreceipted=1/);
  for (const path of [f.shared, ...f.agents.slice(1)]) assert.ok(summary.includes(dirname(path)));
  assert.equal(f.artifact("doctor").attempts.length, 1);
  assert.equal(f.artifact("doctor").attempts[0].exit, exit);
});

test("same-schema completed Doctor refusals can be explicitly accepted forward", t => {
  const f = fixture(t, { preexisting: false, fiveAgents: true });
  partialDoctor(f, { crossing: false });
  f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.match(f.ok(f.command("migration-nocow-summary")), /nocow=partial refused=5/);
  assert.equal(fs.realpathSync(join(f.serving, "current")), f.candidate);
});

for (const legacy of [false, true]) test(`qualified refusal with staging remains reported as COW (legacy binding=${legacy})`, t => {
  const f = fixture(t, { preexisting: false, fiveAgents: true });
  const directory = dirname(f.agent), staging = directory + ".nocow-snapshots-staging";
  fs.mkdirSync(staging);
  partialDoctor(f, { crossing: false });
  f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  const binding = f.artifact("rebinding"), entry = binding.directories.find(row => row.path === directory);
  assert.equal(entry.nocow, "interrupted");
  assert.deepEqual(entry.retainedStaging, [staging]);
  if (legacy) {
    entry.nocow = "refused"; delete entry.retainedStaging;
    f.replaceArtifact("rebinding", binding);
  }
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  const summary = f.ok(f.command("migration-nocow-summary"));
  assert.match(summary, /nocow=partial refused=5/);
  for (const path of f.agents) assert.ok(summary.includes(dirname(path)), summary);
  assert.equal(fs.existsSync(staging), true);
  assert.deepEqual(f.artifact("rebinding"), binding, "persisted partial evidence stays unchanged");
});

for (const scenario of ["wrong original inode", "missing snapshots", "duplicate backup", "duplicate snapshots", "retained metadata", "retained symlink", "installed symlink", "auxiliary schema", "schema drift", "missing C", "data-at-risk", "incomplete-migration", "needs inspection", "null without signal", "no flag", "permit drift"])
test(`unreceipted partial recovery refuses ${scenario}`, t => {
  const f = fixture(t, { preexisting: false, fiveAgents: true, auxiliary: true, beforePreflight: codexWrappers });
  const rewrite = interruptedDoctor(f, { exit: scenario === "null without signal" ? null : 124,
    signal: scenario !== "null without signal", extra: scenario });
  let pattern;
  if (scenario === "wrong original inode") {
    fs.renameSync(rewrite.replacement, rewrite.replacement + "-retained");
    // Keep the real original outside the inference prefix, without deleting it.
    fs.renameSync(rewrite.replacement + "-retained", dirname(f.agent) + ".original-retained");
    copyStore(dirname(f.agent), rewrite.replacement); pattern = /pre-Doctor inode/;
  }
  if (scenario === "missing snapshots") { fs.rmdirSync(rewrite.snapshots); pattern = /exactly one snapshots sibling/; }
  if (scenario === "duplicate backup") { fs.mkdirSync(rewrite.replacement + "2"); pattern = /exactly one retained backup/; }
  if (scenario === "duplicate snapshots") { fs.mkdirSync(rewrite.snapshots + "2"); pattern = /exactly one snapshots sibling/; }
  if (scenario === "retained metadata") fs.chmodSync(join(rewrite.replacement, "openclaw-agent.sqlite"), 0o644);
  if (scenario.endsWith("symlink")) {
    const root = scenario.startsWith("retained") ? rewrite.replacement : dirname(f.agent);
    const path = join(root, "codex-home/tmp/arg0/codex-arg0-fixture/codex");
    fs.unlinkSync(path); fs.symlinkSync("changed", path);
  }
  if (scenario === "auxiliary schema" || scenario === "schema drift") {
    const db = new DatabaseSync(scenario === "auxiliary schema" ? f.auxiliaryPaths[2] : f.agent);
    db.exec("CREATE TABLE unexpected(value)"); db.close();
  }
  if (scenario === "missing C") fs.writeFileSync(f.filesystemOverrides, "{}");
  if (scenario === "permit drift") {
    f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
    f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
    fs.rmdirSync(rewrite.snapshots);
  }
  const result = f.command(scenario === "no flag" ? "offline-doctor-recover" : scenario === "permit drift" ? "migration-permit-publish" : "offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(result.status, 0, result.stdout);
  if (pattern) assert.match(result.stderr, pattern);
  assert.equal(fs.existsSync(f.permit), false);
  assert.equal(fs.realpathSync(join(f.serving, "current")), f.candidate);
});

function codexWrappers({ agent }, name = "codex-arg0-fixture") {
  const directory = join(dirname(agent), "codex-home/tmp/arg0", name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, target] of [["codex", "/missing-release/bin/codex"], ["relative", "../.././bin/codex"],
    ["dangling.sqlite", "missing"], ["ancestor", ".."]]) fs.symlinkSync(target, join(directory, name));
  fs.writeFileSync(join(directory, ".lock"), "", { mode: 0o600 });
  return directory;
}

for (const outcome of ["rewritten", "preexisting", "refused"]) test(`nested symbolic links survive ${outcome} NOCOW verification`, t => {
  let wrapper;
  const f = fixture(t, { crossing: outcome === "refused", preexisting: outcome === "preexisting", liveProbe: true,
    beforePreflight: paths => { wrapper = codexWrappers(paths); } });
  for (const capture of [f.readLiveCapture(), f.artifact("precapture"), f.artifact("nocow")]) {
    const entries = capture.directories.flatMap(row => row.entries), links = entries.filter(entry => entry.kind === "symlink");
    assert.equal(links.length, 4);
    for (const entry of links) {
      const stat = fs.lstatSync(entry.path);
      assert.deepEqual(entry, { path: entry.path, kind: "symlink", linkText: fs.readlinkSync(entry.path), uid: stat.uid, gid: stat.gid });
    }
    assert.equal(entries.find(entry => entry.path === join(wrapper, ".lock")).size, 0);
  }
  if (outcome === "rewritten") { f.rewrite(dirname(f.shared)); f.rewrite(dirname(f.agent)); }
  if (outcome === "refused") { partialDoctor(f); f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT])); }
  else f.ok(f.verify());
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  assert.equal(f.artifact("rebinding").directories.find(row => row.path === dirname(f.agent)).nocow, outcome);
});

for (const outcome of ["rewritten", "preexisting", "refused"]) for (const change of ["drop", "text", "file", "link", "uid", "gid"])
test(`${outcome} NOCOW refuses symbolic link ${change} drift`, t => {
  let wrapper;
  const f = fixture(t, { crossing: outcome === "refused", preexisting: outcome === "preexisting",
    beforePreflight: paths => { wrapper = codexWrappers(paths); } });
  if (outcome === "rewritten") { f.rewrite(dirname(f.shared)); f.rewrite(dirname(f.agent)); }
  if (outcome === "refused") partialDoctor(f);
  const path = join(wrapper, change === "link" ? ".lock" : "relative");
  if (["uid", "gid"].includes(change)) {
    const facts = JSON.parse(fs.readFileSync(f.filesystemOverrides));
    facts[path] = { [change]: fs.lstatSync(path)[change] + 1 };
    fs.writeFileSync(f.filesystemOverrides, JSON.stringify(facts));
  } else {
    fs.unlinkSync(path);
    if (change === "text" || change === "link") fs.symlinkSync("changed", path);
    if (change === "file") fs.writeFileSync(path, "");
  }
  const result = outcome === "refused" ? f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]) : f.verify();
  assert.notEqual(result.status, 0);
  const key = { drop: "membership", text: "linkText", file: "kind", link: "kind", uid: "uid", gid: "gid" }[change];
  assert.match(result.stderr, /offline Doctor changed symbolic link/);
  assert.ok(result.stderr.includes(JSON.stringify(path)) && result.stderr.includes(`(key: ${key})`), result.stderr);
  assert.doesNotMatch(result.stderr, /\.\.\/\.\.\/\.\/bin\/codex/);
  assert.equal(f.load().record.agentMigration.artifacts.rebinding, undefined);
  assert.equal(fs.existsSync(f.permit), false);
});

for (const change of ["drop", "text", "file", "link", "uid", "gid"]) test(`NOCOW refuses retained original symbolic link ${change} drift`, t => {
  let wrapper;
  const f = fixture(t, { beforePreflight: paths => { wrapper = codexWrappers(paths); } });
  const retained = f.rewrite(dirname(f.agent));
  const path = join(retained.replacement, wrapper.slice(dirname(f.agent).length), change === "link" ? ".lock" : "relative");
  if (["uid", "gid"].includes(change)) {
    fs.writeFileSync(f.filesystemOverrides, JSON.stringify({ [path]: { [change]: fs.lstatSync(path)[change] + 1 } }));
  } else {
    fs.unlinkSync(path);
    if (change === "text" || change === "link") fs.symlinkSync("changed", path);
    if (change === "file") fs.writeFileSync(path, "");
  }
  const result = f.verify();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /retained original symbolic link/);
  assert.ok(result.stderr.includes(JSON.stringify(path)), result.stderr);
  assert.equal(fs.existsSync(f.permit), false);
});

for (const crossing of [false, true]) test(`live wrapper churn does not bind the post-stop membership (crossing=${crossing})`, t => {
  let removed, added;
  const f = fixture(t, { crossing, liveProbe: true,
    beforePreflight: paths => { removed = codexWrappers(paths, "codex-arg0-live"); },
    beforeCold: paths => { fs.rmSync(removed, { recursive: true }); added = codexWrappers(paths, "codex-arg0-cold"); } });
  const livePaths = f.readLiveCapture().directories.flatMap(row => row.entries.map(entry => entry.path));
  assert.ok(livePaths.includes(removed)); assert.ok(!livePaths.includes(added));
  for (const capture of [f.artifact("precapture"), f.artifact("nocow")]) {
    const entries = capture.directories.flatMap(row => row.entries);
    assert.ok(!entries.some(entry => entry.path.startsWith(removed)));
    assert.equal(entries.filter(entry => entry.path.startsWith(added) && entry.kind === "symlink").length, 4);
  }
  if (crossing) migrateShared(f);
  f.ok(f.verify());
});

test("symbolic link capture preserves non-UTF-8 target bytes and refuses distinct invalid bytes", t => {
  let path;
  const f = fixture(t, { beforePreflight: ({ agent }) => {
    path = join(dirname(agent), "raw-link"); fs.symlinkSync(Buffer.from([0xff]), path);
  } });
  for (const capture of [f.artifact("precapture"), f.artifact("nocow")]) {
    const entry = capture.directories.flatMap(row => row.entries).find(entry => entry.path === path);
    assert.deepEqual(Buffer.from(entry.linkText, "latin1"), Buffer.from([0xff]));
  }
  fs.unlinkSync(path); fs.symlinkSync(Buffer.from([0xfe]), path);
  const result = f.verify();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /changed symbolic link.*key: linkText/);
});

test("strict post-stop byte capture still refuses a newly created FIFO", t => {
  assert.throws(() => fixture(t, { beforeCold: ({ agent }) => {
    assert.equal(spawnSync("mkfifo", [join(dirname(agent), "pipe")]).status, 0);
  } }), /aliases or unsupported entries/);
});

for (const entry of ["FIFO", "hard link", "linked store", "linked parent"]) test(`live NOCOW preflight still refuses a ${entry}`, t => {
  assert.throws(() => fixture(t, { beforePreflight: ({ agent }) => {
    const directory = dirname(agent);
    if (entry === "FIFO") assert.equal(spawnSync("mkfifo", [join(directory, "pipe")]).status, 0);
    if (entry === "hard link") fs.linkSync(agent, join(directory, "alias"));
    if (entry === "linked store" || entry === "linked parent") {
      const path = entry === "linked store" ? directory : dirname(directory);
      fs.renameSync(path, path + ".original"); fs.symlinkSync(path + ".original", path);
    }
  } }), /aliases or unsupported entries|canonical|symlink|physical database/i);
});

for (const wrapped of [false, true]) test(`explicit partial acceptance verifies the live five-agent shape without another Doctor attempt (wrapped=${wrapped})`, t => {
  const f = fixture(t, { crossing: true, preexisting: false, fiveAgents: true, auxiliary: true });
  partialDoctor(f, { wrapped });
  const doctor = f.artifact("doctor"), original = f.load().record.protectedPaths;
  assert.match(f.verify().stderr, /refused or needs inspection/);
  f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  const binding = f.artifact("rebinding");
  assert.equal(binding.nocow, "partial");
  assert.equal(binding.directories.filter(row => row.nocow === "rewritten").length, 1);
  assert.equal(binding.directories.filter(row => row.nocow === "refused").length, 5);
  assert.ok(binding.directories.filter(row => row.nocow === "refused").every(row => row.refusal.replaceAll("\n", "").includes(row.path)));
  assert.equal(binding.partialNocowAccepted.flag, "--accept-partial-nocow");
  assert.equal(binding.partialNocowAccepted.operator.uid, process.getuid());
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  assert.notDeepEqual(f.load().record.protectedPaths, original);
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(fs.existsSync(f.permit), true);
  assert.deepEqual(f.artifact("doctor"), doctor);
  assert.match(f.ok(f.command("migration-nocow-summary")), /nocow=partial refused=5 cow-directories=/);
});

for (const scenario of ["data-at-risk", "incomplete-migration", "needs inspection", "NOCOW staging cleanup failed", "nonzero exit", "incomplete log", "unknown directory", "changed inode", "changed metadata", "changed auxiliary", "added file", "C added", "changed log"])
test(`partial acceptance refuses ${scenario}`, t => {
  const f = fixture(t, { crossing: true, preexisting: false, auxiliary: true });
  partialDoctor(f, { exit: scenario === "nonzero exit" ? 17 : 0, complete: scenario !== "incomplete log",
    extra: scenario === "unknown directory" ? "SQLite NOCOW repair refused for /unknown: store files are open (pids: 123)" : scenario });
  if (scenario === "changed inode") f.rewrite(dirname(f.agent), false);
  if (scenario === "changed metadata") fs.chmodSync(dirname(f.agent), 0o750);
  if (scenario === "changed auxiliary") {
    const db = new DatabaseSync(f.auxiliaryPaths[2]); db.exec("CREATE TABLE unexpected(value)"); db.close();
  }
  if (scenario === "added file") fs.writeFileSync(join(dirname(f.agent), "unexpected"), "new");
  if (scenario === "C added") fs.writeFileSync(f.filesystemOverrides, JSON.stringify({
    [dirname(f.shared)]: { type: 0x9123683e, flags: "C" }, [dirname(f.agent)]: { type: 0x9123683e, flags: "C" },
  }));
  if (scenario === "changed log") fs.appendFileSync(f.log + ".stdout", "tampered\n");
  const result = f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(f.load().record.agentMigration.artifacts.rebinding, undefined);
  assert.equal(fs.existsSync(f.permit), false);
});

test("partial acceptance still refuses arbitrary same-schema Doctor failure", t => {
  const f = fixture(t); assert.notEqual(f.verify(17).status, 0);
  assert.match(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]).stderr, /exited 0 or been interrupted/);
  assert.equal(fs.existsSync(f.permit), false);
});

test("partial permit rechecks refused directory metadata and retained target schemas", t => {
  const f = fixture(t, { crossing: true, preexisting: false }); partialDoctor(f);
  f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  fs.chmodSync(dirname(f.agent), 0o750);
  assert.notEqual(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]).status, 0);
  assert.equal(fs.existsSync(f.permit), false);
});

for (const crossing of [false, true]) test(`live NOCOW preflight tolerates a busy auxiliary database; cold capture refuses (crossing=${crossing})`, t => {
  let lock;
  try {
    const f = fixture(t, { crossing, auxiliary: true, liveProbe: true, captureFailure: true, beforePreflight: ({ auxiliaryPaths }) => {
      lock = new DatabaseSync(auxiliaryPaths[2]);
      lock.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; UPDATE records SET value='held';");
      assert.equal(fs.existsSync(auxiliaryPaths[2] + "-journal"), true);
    } });
    const entry = f.readLiveCapture().directories.flatMap(row => row.entries).find(row => row.path === f.auxiliaryPaths[2]);
    assert.equal(entry.sqliteRole, "auxiliary"); assert.equal(entry.liveState, "busy");
    assert.equal(Object.hasOwn(entry, "schema"), false);
    assert.ok(entry.inode); assert.ok(entry.acl);
    assert.ifError(f.captureResult.error);
    assert.match(f.captureResult.stderr, /database is locked/);
    assert.equal(f.load().record.agentMigration.artifacts.nocow, undefined);
    assert.equal(f.load().record.agentMigration.artifacts.doctor, undefined);
  } finally { lock?.close(); }
});

test("live NOCOW preflight still rejects a locked primary store", t => {
  let lock;
  try {
    assert.throws(() => fixture(t, { liveProbe: true, pauseRehearsal: true, beforePreflight: ({ agent }) => {
      lock = new DatabaseSync(agent);
      lock.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; UPDATE schema_meta SET created_at=2;");
    } }), /database is locked/);
  } finally { lock?.close(); }
});

for (const crossing of [false, true]) for (const preexisting of [false, true])
test(`busy live auxiliary capture retains filesystem facts before strict cold NOCOW proof (crossing=${crossing}, preexisting=${preexisting})`, t => {
  let lock;
  try {
    const f = fixture(t, { crossing, preexisting, auxiliary: true, liveProbe: true,
      beforePreflight: ({ auxiliaryPaths }) => {
        lock = new DatabaseSync(auxiliaryPaths[2]);
        lock.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; UPDATE records SET value='held';");
      },
      beforeCold: () => { lock.close(); lock = undefined; },
    });
    const live = f.readLiveCapture(), cold = f.artifact("nocow"), bytes = f.artifact("precapture");
    for (const capture of [live, cold, bytes]) {
      assert.equal(capture.version, 2);
      assert.deepEqual(capture.directories.map(row => row.directory).sort(), [dirname(f.shared), dirname(f.agent)].sort());
      for (const row of capture.directories)
        assert.deepEqual(row.filesystem, { type: 0x9123683e, flags: preexisting ? "---------------C--" : "------------------" });
    }
    const entry = capture => capture.directories.flatMap(row => row.entries).find(row => row.path === f.auxiliaryPaths[2]);
    assert.equal(entry(live).liveState, "busy");
    assert.equal(Object.hasOwn(entry(live), "schema"), false);
    assert.equal(Object.hasOwn(entry(cold), "liveState"), false);
    assert.equal(entry(cold).sqliteRole, "auxiliary");
    assert.ok(entry(cold).schema.schema.some(row => row.name === "records"));
    assert.match(entry(bytes).sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(entry(bytes), "liveState"), false);
    assert.equal(f.readQueries().filter(row => row.command === "offline-doctor-capture" && row.sql === "PRAGMA quick_check").length, 5);
    if (crossing) {
      const db = new DatabaseSync(f.shared);
      try { db.exec("PRAGMA user_version=20; UPDATE schema_meta SET schema_version=20;"); }
      finally { db.close(); }
    }
    if (!preexisting) { f.rewrite(dirname(f.shared)); f.rewrite(dirname(f.agent)); }
    f.ok(f.verify());
    f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
    assert.deepEqual(f.artifact("rebinding").directories.map(row => row.nocow), Array(2).fill(preexisting ? "preexisting" : "rewritten"));
  } finally { lock?.close(); }
});

test("live NOCOW preflight still rejects non-lock auxiliary SQLite errors", t => {
  assert.throws(() => fixture(t, { auxiliary: true, liveProbe: true, pauseRehearsal: true, beforePreflight: ({ auxiliaryPaths }) => {
    fs.writeFileSync(auxiliaryPaths[2], "not a SQLite database");
  } }), /not a database/);
});

test("live primary reads skip quick_check while cold capture and Doctor verification require it", t => {
  const f = fixture(t, { liveProbe: true });
  f.ok(f.verify());
  const queries = f.readQueries();
  const checks = command => queries.filter(row => row.command === command && row.sql === "PRAGMA quick_check");
  assert.equal(checks("offline-doctor-preflight").length, 0);
  assert.equal(checks("offline-doctor-capture").length, 2);
  assert.equal(checks("offline-doctor-verify").length, 2);
  for (const path of [f.shared, f.agent]) {
    const entry = f.readLiveCapture().directories.flatMap(row => row.entries).find(row => row.path === path);
    assert.equal(entry.sqliteRole, "primary"); assert.equal(entry.schema.userVersion, 1);
    assert.ok(entry.schema.schemaMeta); assert.ok(entry.schema.schema.length);
  }
});

test("Team-shaped auxiliary SQLite files without schema_meta survive offline capture and rewrite", t => {
  const f = fixture(t, { auxiliary: true });
  f.rewrite(dirname(f.shared)); f.rewrite(dirname(f.agent));
  f.ok(f.verify()); f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  assert.equal(f.artifact("rebinding").databases.length, 5);
  for (const path of f.auxiliaryPaths) {
    const entry = f.artifact("nocow").directories.flatMap(row => row.entries).find(row => row.path === path);
    assert.equal(entry.sqliteRole, "auxiliary");
    assert.deepEqual(Object.keys(entry.schema), ["schema"]);
  }
  assert.equal(fs.readFileSync(join(f.nested, "note"), "utf8"), "synthetic store entry");
});

function migrateShared(f, version = 20) {
  const db = new DatabaseSync(f.shared);
  db.exec(`PRAGMA user_version=${version}; UPDATE schema_meta SET schema_version=${version};
    ALTER TABLE plugin_state_entries ADD COLUMN migrated_value TEXT;`);
  db.close();
}

for (const crossing of [false, true]) for (const partial of [false, true])
test(`${crossing ? "crossing" : "same-schema"} Doctor refuses ${partial ? "partial" : "absent"} NOCOW rewrite`, t => {
  const f = fixture(t, { crossing, preexisting: false });
  const original = Object.fromEntries(["inventory", "backups", "witness", "precapture", "nocow"].map(kind => [kind, f.artifact(kind)]));
  for (const kind of ["precapture", "nocow"]) {
    assert.equal(original[kind].version, 2);
    for (const row of original[kind].directories) assert.deepEqual(row.filesystem, { type: 0x9123683e, flags: "------------------" });
  }
  if (partial) f.rewrite(dirname(f.shared));
  if (crossing) migrateShared(f);
  const result = f.verify();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /NOCOW rewrite did not happen/);
  assert.ok(result.stderr.includes(JSON.stringify(dirname(f.agent))));
  const record = f.load().record;
  assert.equal(record.agentMigration.phase, "doctor-started");
  assert.equal(record.agentMigration.artifacts.rebinding, undefined);
  assert.ok(f.artifact("failure"));
  assert.notEqual(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]).status, 0);
  assert.equal(fs.existsSync(f.permit), false);
  if (crossing) {
    const db = new DatabaseSync(f.shared, { readOnly: true });
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 20); db.close();
    assert.match(f.command("offline-doctor-recover", [f.env.OPENCLAW_TEAM_PROC_ROOT]).stderr, /forward-only/);
    assert.equal(fs.realpathSync(join(f.serving, "current")), f.candidate);
  }
  for (const [kind, value] of Object.entries(original)) assert.deepEqual(f.artifact(kind), value);
});

for (const report of [
  "SQLite NOCOW repair skipped: GNU mv with --exchange and --no-copy is required. Stores remain unchanged.",
  "│ sQlItE NOCOW repair │\n│ skipped: GNU mv is required. │",
  "NOCOW check skipped: lsattr is unavailable or could not read file attributes.",
  "│ nocow check │\n│ SKIPPED: lsattr is unavailable. │",
]) test(`offline Doctor refuses skipped repair report ${JSON.stringify(report)}`, t => {
  const f = fixture(t);
  fs.appendFileSync(f.log + ".stderr", report);
  const result = f.verify();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /offline Doctor refused or needs inspection/);
  assert.equal(f.load().record.agentMigration.artifacts.rebinding, undefined);
  assert.equal(fs.existsSync(f.permit), false);
});

for (const type of [0x9123683e, 0x1234]) test(`adding C without a receipt-verified replacement refuses (filesystem ${type})`, t => {
  const f = fixture(t, { preexisting: false });
  fs.writeFileSync(f.filesystemOverrides, JSON.stringify(Object.fromEntries([f.shared, f.agent].map(path => [dirname(path), { type, flags: "---------------C--" }]))));
  const result = f.verify();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /NOCOW rewrite did not happen/);
  assert.equal(fs.existsSync(f.permit), false);
});

test("start permit rechecks NOCOW on an unchanged directory", t => {
  const f = fixture(t, { crossing: true }); migrateShared(f);
  f.ok(f.verify()); f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  fs.writeFileSync(f.filesystemOverrides, JSON.stringify({ [dirname(f.agent)]: { flags: "------------------" } }));
  const result = f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /NOCOW rewrite did not happen/);
  assert.equal(fs.existsSync(f.permit), false);
});

for (const mutate of ["missing directory", "missing facts", "unknown version", "duplicate directory", "outside inventory"]) test(`capture refuses ${mutate}`, t => {
  const f = fixture(t), capture = f.artifact("nocow");
  if (mutate === "missing directory") capture.directories.pop();
  if (mutate === "missing facts") delete capture.directories[0].filesystem;
  if (mutate === "unknown version") capture.version = 3;
  if (mutate === "duplicate directory") capture.directories.push(capture.directories[0]);
  if (mutate === "outside inventory") {
    const directory = f.root + "/outside";
    capture.directories.push({ directory, filesystem: capture.directories[0].filesystem,
      entries: [{ ...capture.directories[0].entries[0], path: directory, directory: true }] });
  }
  f.replaceArtifact("nocow", capture);
  assert.notEqual(f.verify().status, 0);
  assert.equal(fs.existsSync(f.permit), false);
});

for (const rewritten of [false, true]) test(`retained legacy capture ${rewritten ? "accepts complete rewrites" : "cannot claim preexisting NOCOW"}`, t => {
  const f = fixture(t);
  f.replaceArtifact("nocow", f.artifact("nocow").directories.map(({ directory, entries }) => ({ directory, entries })));
  if (rewritten) { f.rewrite(dirname(f.shared)); f.rewrite(dirname(f.agent)); }
  const result = f.verify();
  if (rewritten) {
    f.ok(result);
    // Model an already-verified, complete legacy binding in a retained journal.
    const binding = f.artifact("rebinding"); binding.version = 1;
    for (const row of binding.directories) row.nocow = true;
    f.replaceArtifact("rebinding", binding);
    f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
    f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  } else { assert.notEqual(result.status, 0); assert.match(result.stderr, /no preexisting NOCOW proof/); }
});

test("incomplete rebinding refuses the start permit", t => {
  const f = fixture(t); f.ok(f.verify()); f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  const binding = f.artifact("rebinding"); binding.directories.pop(); f.replaceArtifact("rebinding", binding);
  const result = f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /every inventory store directory/);
  assert.equal(fs.existsSync(f.permit), false);
});

test("a receipt outside the store inventory still refuses", t => {
  const f = fixture(t), directory = join(f.root, "unowned-store");
  fs.appendFileSync(f.log + ".stdout", `Rewrote SQLite store directory with NOCOW: ${directory}. Original retained at ${directory}.nocow-backup-fixture; verified WAL-aware snapshots at ${directory}.nocow-snapshots-fixture.\n`);
  const result = f.verify();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /unparseable NOCOW receipt/);
  assert.equal(fs.existsSync(f.permit), false);
});

test("schema crossing plus NOCOW verifies declared targets, rebinds identities and permits candidate start", t => {
  const f = fixture(t, { crossing: true, auxiliary: true, preexisting: false });
  const originals = Object.fromEntries(["inventory", "backups", "witness", "nocow"].map(kind => [kind, f.artifact(kind)]));
  assert.equal(f.proof("migration-record-kind", [f.journal, f.serving]), "state-19-20");
  assert.equal(f.proof("migration-record-nocow", [f.journal, f.serving]), "1");
  f.rewrite(dirname(f.shared)); f.rewrite(dirname(f.agent)); migrateShared(f);
  f.ok(f.verify()); f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  assert.deepEqual(f.artifact("rebinding").directories.map(row => row.nocow), ["rewritten", "rewritten"]);
  assert.equal(f.load().record.protectedPaths[1].inode, fs.statSync(f.shared).ino);
  assert.notEqual(f.load().record.protectedPaths[1].inode, originals.inventory.stores.find(row => row.path === f.shared).inode);
  assert.equal(f.artifact("rebinding").databases.find(row => row.path === f.shared).schema.facts.userVersion, 20);
  assert.equal(f.artifact("rebinding").databases.find(row => row.path === f.agent).schema.facts.userVersion, 24);
  const witness = JSON.parse(f.ok(f.command("migration-original-witness")));
  assert.equal(JSON.parse(witness[0])[3], fs.statSync(f.agent).ino);
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(fs.existsSync(f.permit), true);
  for (const [kind, original] of Object.entries(originals)) assert.deepEqual(f.artifact(kind), original);
});

for (const [name, mutate, pattern] of [
  ["unreceipted exchange without snapshots", f => { fs.rmdirSync(f.rewrite(dirname(f.shared), false).snapshots); migrateShared(f); }, /exactly one snapshots sibling/],
  ["receipt with source schema", f => f.rewrite(dirname(f.shared)), /physical schema/],
  ["receipt with too-new schema", f => { f.rewrite(dirname(f.shared)); migrateShared(f, 21); }, /physical schema/],
  ["receipt with wrong schema_meta", f => { f.rewrite(dirname(f.shared)); migrateShared(f); const db = new DatabaseSync(f.shared); db.exec("UPDATE schema_meta SET schema_version=19"); db.close(); }, /physical schema/],
  ["receipt with future effective content", f => { f.rewrite(dirname(f.shared)); migrateShared(f); const db = new DatabaseSync(f.shared); db.exec("INSERT INTO config_machine_state VALUES('state.schema.contentVersion','21')"); db.close(); }, /physical schema/],
  ["receipt with missing registry", f => { f.rewrite(dirname(f.shared)); migrateShared(f); const db = new DatabaseSync(f.shared); db.exec("DROP TABLE agent_databases"); db.close(); }, /registry/],
  ["receipt with wrong registry version", f => { f.rewrite(dirname(f.shared)); migrateShared(f); const db = new DatabaseSync(f.shared); db.exec("UPDATE agent_databases SET schema_version=23"); db.close(); }, /registry/],
  ["receipt with auxiliary DDL drift", f => { f.rewrite(dirname(f.shared)); migrateShared(f); const db = new DatabaseSync(f.auxiliaryPaths[0]); db.exec("CREATE TABLE unexpected(value TEXT)"); db.close(); }, /physical schema/],
]) test(`schema crossing refuses ${name} and cannot recover to predecessor`, t => {
  const f = fixture(t, { crossing: true, auxiliary: true }), before = f.load().record.protectedPaths;
  mutate(f);
  const result = f.verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, pattern);
  assert.deepEqual(f.load().record.protectedPaths, before);
  assert.equal(f.load().record.agentMigration.artifacts.rebinding, undefined);
  assert.ok(f.artifact("failure"));
  const recovery = f.command("offline-doctor-recover", [f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(recovery.status, 0); assert.match(recovery.stderr, /forward-only/);
  assert.notEqual(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]).status, 0);
  assert.equal(fs.realpathSync(join(f.serving, "current")), f.candidate);
  assert.equal(fs.existsSync(f.permit), false);
});

test("state20 NOCOW crossing refuses an already-target cold capture", t => {
  assert.throws(() => fixture(t, { crossing: true, beforeCold: ({ shared }) => {
    const db = new DatabaseSync(shared); db.exec("PRAGMA user_version=20; UPDATE schema_meta SET schema_version=20"); db.close();
  } }), /requires original state19 cold evidence/);
});

test("crossing rechecks receipt metadata before publishing the start permit", t => {
  const f = fixture(t, { crossing: true });
  f.rewrite(dirname(f.shared)); migrateShared(f);
  f.ok(f.verify()); f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  fs.chmodSync(f.shared, 0o644);
  const result = f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /ownership, mode, ACL/);
  assert.equal(fs.existsSync(f.permit), false);
});

test("migration forward retry keeps original capture, failure and receipt logs through target verification", t => {
  const f = fixture(t, { crossing: true });
  f.rewrite(dirname(f.shared)); f.rewrite(dirname(f.agent));
  assert.notEqual(f.verify(17).status, 0);
  const original = Object.fromEntries(["inventory", "backups", "witness", "nocow", "failure"].map(kind => [kind, f.artifact(kind)]));
  f.ok(f.command("offline-doctor-capture", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  f.ok(f.command("offline-doctor-intent", [join(dirname(f.log), "doctor-20261001T000000Z-456"), f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(f.ok(f.command("offline-doctor-log", [f.env.OPENCLAW_TEAM_PROC_ROOT])), f.log);
  migrateShared(f);
  f.ok(f.verify()); f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  for (const [kind, value] of Object.entries(original)) assert.deepEqual(f.artifact(kind), value);
});

for (const scenario of ["verified rewrite", "receiptless rewrite", "missing NOCOW outcome", "historical refusal", "accepted partial", "accepted partial resumed", "same-schema timeout partial", "same-schema timeout partial resumed", "crossing timeout partial"]) test(`migration shell recovery after ${scenario}`, t => {
  const timeout = scenario.includes("timeout"), sameSchema = scenario.startsWith("same-schema");
  const partial = scenario.startsWith("accepted partial") || timeout, resumed = scenario.endsWith("resumed");
  const missing = scenario === "missing NOCOW outcome", historical = scenario === "historical refusal", receipt = scenario !== "receiptless rewrite";
  const f = fixture(t, { crossing: !sameSchema, preexisting: !missing && !historical && !partial, fiveAgents: partial });
  if (timeout) interruptedDoctor(f, { crossing: !sameSchema });
  else if (partial) partialDoctor(f);
  else if (historical) {
    f.rewrite(dirname(f.shared)); migrateShared(f);
    fs.appendFileSync(f.log + ".stderr", `SQLite NOCOW repair refused for ${dirname(f.agent)}: synthetic busy directory.\n`);
  } else if (missing) migrateShared(f);
  else { f.rewrite(dirname(f.shared), receipt); f.rewrite(dirname(f.agent)); }
  const refused = f.verify(timeout ? 124 : missing || partial ? 0 : 17);
  assert.notEqual(refused.status, 0);
  if (missing) assert.match(refused.stderr, /NOCOW rewrite did not happen/);
  const original = Object.fromEntries(["inventory", "backups", "witness", "precapture", "nocow", "failure"].map(kind => [kind, f.artifact(kind)]));
  if (resumed) f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  const source = fs.readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
  const extract = (name, next) => source.slice(source.indexOf(`${name}() {`), source.indexOf(`\n${next}() {`));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const events = join(f.root, "forward-events"), script = join(f.root, "forward-recovery.sh");
  const doctor = join(f.root, "retry-doctor.mjs"), attempts = join(f.root, "doctor-attempts");
  fs.writeFileSync(doctor, `import * as fs from 'node:fs';import {join} from 'node:path';
${copyStore.toString()}
fs.appendFileSync(${JSON.stringify(attempts)}, 'candidate-doctor\\n');
if (${missing || historical}) for (const directory of ${JSON.stringify(historical ? [dirname(f.agent)] : [dirname(f.shared), dirname(f.agent)])}) {
  const backup=directory+'.nocow-backup-retry', snapshots=directory+'.nocow-snapshots-retry', temporary=directory+'.exchange';
  copyStore(directory,backup); fs.mkdirSync(snapshots,{mode:0o700});
  fs.renameSync(directory,temporary);fs.renameSync(backup,directory);fs.renameSync(temporary,backup);
  const path=${JSON.stringify(f.filesystemOverrides)}, facts=JSON.parse(fs.readFileSync(path));
  facts[directory]={type:0x9123683e,flags:'---------------C--'};fs.writeFileSync(path,JSON.stringify(facts));
  console.log('Rewrote SQLite store directory with NOCOW: '+directory+'. Original retained at '+backup+'; verified WAL-aware snapshots at '+snapshots+'.');
}
`);
  fs.writeFileSync(script, `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == '--recover --allow-cpu-degraded' ]]
mode=recover; accept_partial_nocow=${partial && !resumed ? 1 : 0}; journal_file=${quote(f.journal)}; serving_root=${quote(f.serving)}; releases_root="$serving_root/releases"
current_link="$serving_root/current"; previous_link="$serving_root/previous"; root_uid=${process.getuid()}
state_database=${quote(f.shared)}; config_file=${quote(f.config)}; proc_root=${quote(f.env.OPENCLAW_TEAM_PROC_ROOT)}
runtime_home=${quote(f.runtime)}; node_bin=${quote(process.execPath)}; runuser_bin=/fixture-runuser; build_budget=2400
proof() { "$node_bin" --no-warnings --import ${quote(join(f.root, "native-probes.mjs"))} ${quote(library)} "$@"; }
fail() { echo "$*" >&2; return 1; }
assert_policy() { :; }
assert_protected_identity() { [[ "$(proof fingerprint "$config_file" "$state_database")" == "$protected_identity" ]]; }
read_pointer() { realpath "$1"; }
migration_native_guard() { :; }
migration_check_guard() { proof migration-check "$journal_file" "$serving_root" "$migration_evidence" >/dev/null; }
stopped_system_owners() { [[ ! -e ${quote(events)} ]]; }
system_state() { if [[ -e ${quote(events)} ]]; then echo active; else echo inactive; fi; }
bounded() {
  [[ "$1 $2" == '2400 /fixture-runuser' && " $* " == *' OPENCLAW_UPDATE_IN_PROGRESS=1 '* ]] || return 91
  [[ " $* " == *' doctor --repair --non-interactive --no-workspace-suggestions '* ]] || return 92
  "$node_bin" ${quote(doctor)}
  "$node_bin" -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA user_version=20; UPDATE schema_meta SET schema_version=20");db.close();' "$state_database"
}
system_systemctl() {
  [[ "$*" == 'start openclaw-gateway.service' && -f ${quote(f.permit)} ]]
  [[ "$(read_pointer "$current_link")" == "$candidate_release" ]]
  assert_protected_identity
  echo candidate-start >${quote(events)}
}
capture_service_generation() { service_pid=222; service_generation=2220; }
wait_for_live() { [[ "$1" == "$candidate_release" ]]; echo candidate-verified >>${quote(events)}; }
recheck_generation() { [[ "$*" == 'system 222 2220' ]]; }
verified_markers() { [[ "$*" == 'record ${"b".repeat(40)}' ]]; }
cleanup_releases() { :; }
recover_offline_doctor_predecessor() { echo forbidden-predecessor >>${quote(events)}; return 99; }
${extract("migration_assert_inputs", "migration_rebind_config_guards")}
${extract("migration_assert_stopped", "migration_capture_record")}
${extract("migration_select_candidate", "recover_agent_schema_migration")}
${extract("recover_agent_schema_migration", "recover_offline_doctor_predecessor")}
recover_agent_schema_migration
`, { mode: 0o700 });
  const result = spawnSync(f.realCommands.bash, [script, "--recover", "--allow-cpu-degraded"], { env: f.env, encoding: "utf8", timeout: 30000 });
  if (partial) {
    assert.equal(fs.existsSync(attempts), false);
    assert.match(result.stdout, timeout ? /SUCCESS .*nocow=partial refused=0 .*interrupted=2 rewritten-unreceipted=1/ : /SUCCESS .*nocow=partial refused=5/);
  }
  else assert.equal(fs.readFileSync(attempts, "utf8"), "candidate-doctor\n");
  for (const [kind, value] of Object.entries(original)) {
    const path = join(dirname(f.log), fs.readdirSync(dirname(f.log)).find(name => name.startsWith(kind + "-") && name.endsWith(".json")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path)), value);
  }
  f.ok(result); assert.match(result.stdout, new RegExp(sameSchema ? "migration=offline-to-doctor" : "migration=state-19-20\\+nocow"));
  assert.equal(fs.statSync(join(f.nested, "note")).mode & 0o7777, 0o640);
  if (missing) assert.equal(fs.statSync(join(dirname(f.shared) + ".nocow-backup-retry", "nested/note")).mode & 0o7777, 0o640);
  assert.equal(fs.readFileSync(events, "utf8"), "candidate-start\ncandidate-verified\n");
  assert.equal(fs.existsSync(f.journal), false);
  assert.equal(fs.realpathSync(join(f.serving, "current")), f.candidate);
});

for (const rewrite of [false, true]) test(`crossing without offline flag ${rewrite ? "refuses inode replacement" : "retains ordinary migration behavior"}`, t => {
  const f = fixture(t, { crossing: true, nocow: false });
  assert.equal(f.proof("migration-record-nocow", [f.journal, f.serving]), "0");
  assert.notEqual(f.command("offline-doctor-capture", [f.env.OPENCLAW_TEAM_PROC_ROOT]).status, 0);
  if (rewrite) f.rewrite(dirname(f.shared));
  migrateShared(f);
  const result = f.command("migration-verify-stores", [f.config, f.shared]);
  if (rewrite) { assert.notEqual(result.status, 0); assert.match(result.stderr, /physical database/); }
  else { f.ok(result); f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT])); }
  assert.equal(fs.existsSync(f.permit), !rewrite);
  assert.equal(f.load().record.agentMigration.artifacts.rebinding, undefined);
});

test("offline Doctor permits clean-close seal removal and replacement beside inventoried databases", t => {
  const f = fixture(t, { auxiliary: true, beforePreflight: ({ shared, agent, auxiliaryPaths }) => {
    for (const path of [shared, agent, auxiliaryPaths[0]]) fs.writeFileSync(`${path}.seal`, "old proof", { mode: 0o600 });
  } });
  fs.unlinkSync(`${f.shared}.seal`);
  fs.writeFileSync(`${f.agent}.seal`, "new proof with different length");
  fs.writeFileSync(`${f.auxiliaryPaths[1]}.seal`, "new auxiliary proof", { mode: 0o600 });
  f.ok(f.verify());
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(fs.existsSync(f.permit), true);
});

test("auxiliary WAL snapshots preserve data without adopting the primary user_version contract", t => {
  const f = fixture(t, { auxiliary: true, beforeCold: ({ auxiliaryPaths }) => {
    const path = auxiliaryPaths[1], db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=42; INSERT INTO records VALUES('wal','committed');");
    const main = fs.readFileSync(path), wal = fs.readFileSync(path + "-wal"); db.close();
    fs.writeFileSync(path, main); fs.writeFileSync(path + "-wal", wal, { mode: 0o600 });
  } });
  const path = f.auxiliaryPaths[1]; f.rewrite(dirname(f.shared));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import {DatabaseSync,backup} from 'node:sqlite';import fs from 'node:fs';
const path=process.argv[1], db=new DatabaseSync(path,{readOnly:true});
await backup(db,path+'.snapshot');db.close();
for(const suffix of ['-wal','-shm']) fs.rmSync(path+suffix,{force:true});
fs.renameSync(path+'.snapshot',path);fs.chmodSync(path,0o600);
`, path], { encoding: "utf8", timeout: 30000 });
  f.ok(result);
  const db = new DatabaseSync(path); db.exec("PRAGMA user_version=43");
  assert.equal(db.prepare("SELECT value FROM records WHERE key='wal'").get().value, "committed"); db.close();
  f.ok(f.verify());
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  assert.equal(f.artifact("nocow").directories.flatMap(row => row.entries).some(row => /-wal$|-shm$/.test(row.path)), false);
});

for (const [name, mutate, pattern] of [
  ["auxiliary physical schema", f => { const db = new DatabaseSync(f.auxiliaryPaths[0]); db.exec("CREATE TABLE unexpected(value TEXT)"); db.close(); }, /physical schema/],
  ["non-SQLite file size", f => fs.appendFileSync(join(f.nested, "note"), "changed"), /file size/],
]) test(`offline Doctor refuses changed ${name}`, t => {
  const f = fixture(t, { auxiliary: true }); f.rewrite(dirname(f.shared)); mutate(f);
  const result = f.verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, pattern);
  assert.equal(fs.existsSync(f.permit), false);
});

function refusedCapture(t) {
  const f = fixture(t, { auxiliary: true, captureFailure: true, beforeCold: ({ auxiliaryPaths }) => {
    const db = new DatabaseSync(auxiliaryPaths[0]);
    const page = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='records'").get().rootpage;
    const pageSize = db.prepare("PRAGMA page_size").get().page_size; db.close();
    // Corrupt the auxiliary table's cell count, leaving its SQLite/schema headers readable.
    const fd = fs.openSync(auxiliaryPaths[0], "r+");
    fs.writeSync(fd, Buffer.from([0xff, 0xff]), 0, 2, (page - 1) * pageSize + 3); fs.closeSync(fd);
  } });
  assert.match(f.captureResult.stderr, /quick_check failed|database disk image is malformed/);
  assert.equal(f.load().record.phase, "C_CURRENT_SELECTED");
  assert.equal(f.load().record.agentMigration.phase, "doctor-started");
  assert.ok(f.load().record.agentMigration.artifacts.precapture);
  assert.equal(f.load().record.agentMigration.artifacts.doctor, undefined);
  assert.equal(f.load().record.agentMigration.artifacts.nocow, undefined);
  assert.equal(fs.existsSync(f.permit), false);
  return f;
}

test("pre-Doctor capture refusal cannot recover changed auxiliary bytes", t => {
  const f = refusedCapture(t), path = f.auxiliaryPaths[1], db = new DatabaseSync(path);
  db.exec("UPDATE records SET value='different'"); db.close();
  const result = f.command("offline-doctor-recover", [f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /pre-Doctor store bytes/);
  assert.equal(fs.existsSync(f.permit), false);
});

test("offline option requires explicit fenced cutover intent", t => {
  const f = makeReleaseFixture(t);
  const result = runOwner(f, ["--offline-doctor-repair"]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /requires a fenced system deployment/);
});

for (const extra of [[], ["--sha", "b".repeat(40)], ["--offline-doctor-repair"], ["--interrupt-after-drain"],
  ["--skip-migration-rehearsal"], ["--capture-startup-profile"], ["--abandon-rehearsal", "b".repeat(40)]])
test(`partial option rejects incompatible invocation ${JSON.stringify(extra)}`, t => {
  const f = makeReleaseFixture(t);
  const result = runOwner(f, [...(extra.length ? ["--recover"] : []), "--accept-partial-nocow", ...extra]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /requires --recover and allows only --allow-cpu-degraded/);
});

test("owner selector keeps the declared migration kind when offline repair is requested", t => {
  const f = makeReleaseFixture(t);
  const source = fs.readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
  const start = source.indexOf("activate_prepared_release() {"), end = source.indexOf("\n}\n", start) + 3;
  const result = spawnSync(f.realCommands.bash, ["-c", `set -euo pipefail
node_bin="$1"; library="$2"; config_file="$3"
previous_info='${JSON.stringify({ sha: "a".repeat(40), schemaVersions: { state: 19, agent: 24 } })}'
candidate_info='${JSON.stringify({ sha: "b".repeat(40), schemaVersions: { state: 20, agent: 24 } })}'
mode=deploy; frozen_target_sha=''; offline_doctor_repair=1; capture_startup_profile=0; arm_steady_profile=0
proof() { "$node_bin" --no-warnings "$library" "$@"; }
fail() { echo "$*" >&2; exit 1; }
activate_agent_schema_migration() { printf '%s repair=%s' "$migration_kind" "$offline_doctor_repair"; }
activate_release() { exit 97; }
${source.slice(start, end)}
activate_prepared_release
`, "fixture", process.execPath, library, f.config], { env: f.env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "state-19-20 repair=1");
});

// Leave freed pages behind so the main file grows without any schema or receipt change, the way
// Doctor's clean close moves a retained original's size by checkpointing its WAL.
function growDatabase(db) {
  db.exec(`CREATE TABLE padding(x TEXT); ${Array.from({ length: 300 }, (_, index) => `INSERT INTO padding VALUES('${"x".repeat(200)}${index}');`).join("")} DROP TABLE padding;`);
}

test("same-schema Doctor may refresh its own schema_meta receipts on rewritten and preexisting stores", t => {
  const f = fixture(t), before = f.load().record.protectedPaths, oldSize = fs.statSync(f.shared).size;
  const retained = f.rewrite(dirname(f.shared)), retainedPath = join(retained.replacement, "openclaw.sqlite");
  // Doctor refreshed the shared store's receipts before copying it, so the retained original and the
  // exchanged copy agree; the retained original's clean close then moved its byte size.
  for (const path of [f.shared, retainedPath]) {
    const db = new DatabaseSync(path);
    db.exec("UPDATE schema_meta SET created_at=2 WHERE meta_key='primary'; INSERT INTO schema_meta VALUES('startup-migrations','global',3,NULL,2)");
    if (path === retainedPath) growDatabase(db);
    db.close();
  }
  assert.notEqual(fs.statSync(retainedPath).size, oldSize);
  const agent = new DatabaseSync(f.agent);
  agent.exec("INSERT INTO schema_meta VALUES('media-transcript-archive-verification-v1','agent',1,'controller-test-agent',2)");
  agent.close();
  f.ok(f.verify());
  const binding = f.artifact("rebinding");
  assert.deepEqual(Object.fromEntries(binding.directories.map(row => [row.path, row.nocow])), { [dirname(f.shared)]: "rewritten", [dirname(f.agent)]: "preexisting" });
  assert.deepEqual(binding.databases.find(row => row.path === f.shared).schema, { kind: "doctor-maintained-meta", metaKeys: ["primary", "startup-migrations"] });
  assert.deepEqual(binding.databases.find(row => row.path === f.agent).schema, { kind: "doctor-maintained-meta", metaKeys: ["media-transcript-archive-verification-v1", "primary"] });
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  assert.equal(f.load().record.agentMigration.phase, "stores-verified");
  assert.notDeepEqual(f.load().record.protectedPaths, before);
});

test("same-schema rewrite independently verifies and journals directory and database identity rebinding", t => {
  const f = fixture(t, { preexisting: false }), old = fs.statSync(dirname(f.shared)), oldDb = fs.statSync(f.shared);
  const retained = f.rewrite(dirname(f.shared)); f.rewrite(dirname(f.agent));
  f.ok(f.verify());
  const binding = f.artifact("rebinding");
  assert.deepEqual(binding.directories.map(row => row.nocow), ["rewritten", "rewritten"]);
  assert.equal(binding.directories.find(row => row.path === dirname(f.shared)).old.inode, old.ino);
  assert.equal(fs.statSync(retained.replacement).ino, old.ino);
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  assert.equal(f.load().record.protectedPaths[1].inode, fs.statSync(f.shared).ino);
  assert.notEqual(f.load().record.protectedPaths[1].inode, oldDb.ino);
  assert.equal(f.load().record.agentMigration.phase, "stores-verified");
  const witness = JSON.parse(f.ok(f.command("migration-original-witness")));
  assert.equal(JSON.parse(witness[0])[3], fs.statSync(f.agent).ino);
  assert.equal(JSON.parse(f.artifact("witness")[0])[3], binding.databases.find(row => row.path === f.agent).old.inode);
});

for (const [name, change, pattern] of [
  ["wrong retained inode", f => { const r = f.rewrite(dirname(f.shared)); fs.renameSync(r.replacement, r.replacement + "-original"); fs.mkdirSync(r.replacement); }, /pre-Doctor inode/],
  ["changed schema_meta version", f => { f.rewrite(dirname(f.shared)); const db = new DatabaseSync(f.shared); db.exec("UPDATE schema_meta SET schema_version=7 WHERE meta_key='primary'"); db.close(); }, /schema_meta/],
  ["foreign schema_meta marker", f => { f.rewrite(dirname(f.shared)); const db = new DatabaseSync(f.shared); db.exec("INSERT INTO schema_meta VALUES('marker','agent',1,'controller-test-agent',2)"); db.close(); }, /schema_meta/],
  ["retained original diverged from its copy", f => { const r = f.rewrite(dirname(f.shared)); const db = new DatabaseSync(join(r.replacement, "openclaw.sqlite")); db.exec("INSERT INTO schema_meta VALUES('startup-migrations','global',3,NULL,2)"); growDatabase(db); db.close(); }, /retained original database diverged/],
  ["unreceipted exchange without snapshots", f => { fs.rmdirSync(f.rewrite(dirname(f.shared), false).snapshots); }, /exactly one snapshots sibling/],
  ["Doctor needs inspection", f => { f.rewrite(dirname(f.shared)); fs.appendFileSync(f.log + ".stderr", "data-at-risk incomplete-migration needs inspection"); }, /needs inspection/],
  ["wrapped refusal", f => { f.rewrite(dirname(f.shared)); fs.appendFileSync(f.log + ".stderr", "│ SQLite NOCOW repair │\n│ refused for store │"); }, /refused or needs inspection/],
  ["mode drift", f => { f.rewrite(dirname(f.shared)); fs.chmodSync(f.shared, 0o644); return [f.shared, "mode"]; }, /ownership, mode, ACL/],
  ["directory mode drift", f => { f.rewrite(dirname(f.shared)); fs.chmodSync(dirname(f.shared), 0o755); return [dirname(f.shared), "mode"]; }, /ownership, mode, ACL/],
  ["retained mode drift", f => { const r = f.rewrite(dirname(f.shared)), path = join(r.replacement, "openclaw.sqlite"); fs.chmodSync(path, 0o644); return [path, "mode"]; }, /retained original entry/],
  ["ACL drift", f => { f.rewrite(dirname(f.shared)); fs.writeFileSync(f.aclOverrides, JSON.stringify({ [f.shared]: "user:4242:rw-" })); return [f.shared, "acl"]; }, /ownership, mode, ACL/],
  ["added entry", f => { f.rewrite(dirname(f.shared)); const path = join(f.nested, 'extra\n"entry'); fs.writeFileSync(path, "private fixture content"); return [path, "membership"]; }, /directory membership changed/],
  ["unrelated seal", f => { f.rewrite(dirname(f.shared)); const path = join(f.nested, "note.seal"); fs.writeFileSync(path, "private fixture content"); return [path, "membership"]; }, /directory membership changed/],
  ["removed entry", f => { f.rewrite(dirname(f.shared)); const path = join(f.nested, "note"); fs.unlinkSync(path); return [path, "membership"]; }, /ownership, mode, ACL/],
]) test(`offline Doctor refuses ${name} without rebinding or start permission`, t => {
  const f = fixture(t), before = f.load().record.protectedPaths;
  const mismatch = change(f), result = f.verify();
  assert.notEqual(result.status, 0); assert.match(result.stderr, pattern);
  if (mismatch) assert.ok(result.stderr.includes(`at ${JSON.stringify(mismatch[0])} (key: ${mismatch[1]})`), result.stderr);
  assert.doesNotMatch(result.stderr, /user:4242|private fixture content/);
  assert.deepEqual(f.load().record.protectedPaths, before);
  assert.equal(f.load().record.agentMigration.artifacts.rebinding, undefined);
  assert.ok(f.artifact("failure").retained.length > 0);
  assert.equal(fs.existsSync(f.permit), false);
});

for (const crossing of [false, true]) test(`${crossing ? "crossing" : "same-schema"} Doctor attests every preexisting NOCOW directory with unchanged identity`, t => {
  const f = fixture(t, { crossing }), before = f.load().record.protectedPaths;
  if (crossing) migrateShared(f);
  f.ok(f.verify()); f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  assert.deepEqual(f.load().record.protectedPaths, before);
  const directories = f.artifact("rebinding").directories;
  assert.equal(directories.length, 2);
  for (const entry of directories) {
    assert.equal(entry.nocow, "preexisting"); assert.deepEqual(entry.old, entry.new); assert.equal(entry.receipt, undefined);
  }
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
});

test("offline verification refuses a present start permit", t => {
  const f = fixture(t); fs.writeFileSync(f.permit, '{"version":1,"purpose":"gateway-start-permit"}\n', { mode: 0o600 });
  const result = f.verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, /revoked-permit fence/);
});

test("failed unchanged Doctor admits only explicit verified predecessor recovery", t => {
  const f = fixture(t); assert.notEqual(f.verify(17).status, 0);
  f.ok(f.command("offline-doctor-recover", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(f.load().record.agentMigration.phase, "recovering-predecessor");
  assert.notEqual(f.command("offline-recovery-permit", [f.env.OPENCLAW_TEAM_PROC_ROOT]).status, 0, "candidate selection cannot receive recovery permit");
  fs.unlinkSync(join(f.serving, "current")); fs.symlinkSync(f.initial, join(f.serving, "current")); fs.unlinkSync(join(f.serving, "previous"));
  f.ok(f.command("offline-recovery-permit", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(fs.existsSync(f.permit), true); assert.equal(f.artifact("failure").exitCode, 17);
});

for (const failure of ["Doctor failure", "pre-Doctor capture refusal", "prepared-phase interruption"]) test(`--recover restores the predecessor after ${failure} and retires only after acceptance`, t => {
  const f = failure === "Doctor failure" ? fixture(t) : failure === "prepared-phase interruption" ? fixture(t, { auxiliary: true, pausePrepared: true }) : refusedCapture(t);
  if (failure === "Doctor failure") assert.notEqual(f.verify(17).status, 0);
  const source = fs.readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
  const extract = (name, next) => source.slice(source.indexOf(name + "() {"), source.indexOf(next + "() {"));
  const script = join(f.root, "recover.sh"), events = join(f.root, "recovery-events");
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(script, `#!/bin/bash
set -euo pipefail
[[ "$1" == --recover ]]; mode=recover
journal_file=${quote(f.journal)}; serving_root=${quote(f.serving)}; releases_root="$serving_root/releases"
current_link="$serving_root/current"; previous_link="$serving_root/previous"; root_uid=${process.getuid()}
previous_release=${quote(f.initial)}; candidate_release=${quote(f.candidate)}; state_database=${quote(f.shared)}
proc_root=${quote(f.env.OPENCLAW_TEAM_PROC_ROOT)}; previous_info='{}'
proof() { ${quote(process.execPath)} --no-warnings --import ${quote(join(f.root, "native-probes.mjs"))} ${quote(library)} "$@"; }
migration_evidence="$(proof migration-load "$journal_file" "$serving_root")"
fail() { echo "$*" >&2; return 1; }
migration_assert_stopped() { [[ ! -e ${quote(events)} ]]; }
read_pointer() { realpath "$1"; }
atomic_pointer() { rm "$2"; ln -s "$1" "$2"; }
load_gateway_runtime() { :; }
system_state() { echo inactive; }
system_systemctl() { [[ "$*" == 'start openclaw-gateway.service' ]]; [[ -f ${quote(f.permit)} ]]; echo started >${quote(events)}; }
capture_service_generation() { service_pid=222; service_generation=2220; mkdir -p "$proc_root/222"; ln -s "$previous_release" "$proc_root/222/cwd"; }
wait_for_live() { [[ "$1" == "$previous_release" && "$4" == 222 && "$5" == 2220 ]]; echo verified >>${quote(events)}; }
assert_protected_identity() { [[ "$(proof fingerprint ${quote(f.config)} ${quote(f.shared)})" == "$protected_identity" ]]; }
assert_policy() { :; }
migration_assert_inputs() { assert_protected_identity; }
migration_check_guard() { :; }
recheck_generation() { [[ "$*" == 'system 222 2220' ]]; }
${extract("restore_pointer_topology", "on_exit")}
${extract("recover_agent_schema_migration", "recover_offline_doctor_predecessor")}
${extract("recover_offline_doctor_predecessor", "install_migration_guard_current")}
recover_agent_schema_migration
`, { mode: 0o700 });
  const result = spawnSync(f.realCommands.bash, [script, "--recover"], { env: f.env, encoding: "utf8", timeout: 30000 });
  f.ok(result);
  assert.match(result.stdout, /RECOVERED action=restored-offline-doctor-predecessor/);
  assert.equal(fs.realpathSync(join(f.serving, "current")), f.initial);
  assert.equal(fs.readFileSync(events, "utf8"), "started\nverified\n");
  assert.equal(fs.existsSync(f.journal), false);
});

test("boxed wrapped native receipts preserve exact directory and database verification", t => {
  const f = fixture(t);
  const receipt = f.rewrite(dirname(f.shared), false);
  const splitPath = path => {
    const split = path.indexOf(".openclaw") + 1;
    return (path.slice(0, split) + "\n" + path.slice(split)).replace(".nocow-", "\n.nocow-")
      .replace(/(backup-|snapshots-)/, "$1\n") + "\n";
  };
  const wrapped = receipt.line.replace("store directory", "store\ndirectory")
    .replace("Original retained", "Original\nretained")
    .replace("WAL-aware snapshots", "WAL-aware\nsnapshots")
    .replace(receipt.replacement, splitPath(receipt.replacement))
    .replace(receipt.snapshots, splitPath(receipt.snapshots));
  fs.appendFileSync(f.log + ".stdout", wrapped.split("\n").map(line => "│  " + line + "  │").join("\n") + "\n");
  f.ok(f.verify());
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(f.load().record.protectedPaths[1].inode, fs.statSync(f.shared).ino);
  assert.equal(f.artifact("rebinding").directories.find(row => row.path === dirname(f.shared)).receipt.backup, receipt.replacement);
  assert.equal(fs.existsSync(f.permit), true);
});


test("interruption after durable Doctor intent recovers unchanged stores before any child output", t => {
  const f = fixture(t), intent = f.artifact("doctor");
  assert.deepEqual(intent.logs.map(log => log.inode), [".stdout", ".stderr"].map(suffix => fs.statSync(f.log + suffix).ino));
  f.ok(f.command("offline-doctor-recover", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(f.load().record.agentMigration.phase, "recovering-predecessor");
  assert.deepEqual(f.artifact("rebinding").directories.map(row => row.nocow), ["preexisting", "preexisting"]);
});

test("a replaced Doctor log refuses even when its contents are unchanged", t => {
  const f = fixture(t);
  fs.renameSync(f.log + ".stdout", f.log + ".stdout-original");
  fs.writeFileSync(f.log + ".stdout", "", { mode: 0o600 });
  const result = f.verify();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Doctor log identity changed/);
  assert.equal(fs.existsSync(f.permit), false);
});

test("cold offline Doctor appends through the existing bounded command without replacing durable logs", t => {
  const f = fixture(t), intent = f.artifact("doctor");
  const source = fs.readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
  const start = source.indexOf('\t\t(umask 077; set -o noclobber', source.indexOf('recover_agent_schema_migration()'));
  const end = source.indexOf('\n\t\tif [[ "$migration_nocow" == 1 ]]; then', start);
  assert.ok(start >= 0 && end > start);
  const result = spawnSync(f.realCommands.bash, ["-c", `set -euo pipefail
migration_kind=offline-doctor; migration_nocow=1; doctor_log="$1"; build_budget=2400; runuser_bin=/fixture-runuser
runtime_home=/fixture-home; config_file=/fixture-home/.openclaw/openclaw.json; node_bin=/fixture-node; candidate_release=/fixture-release; doctor_exit=0
bounded() {
  [[ "$1 $2" == '2400 /fixture-runuser' ]] || return 91
  [[ " $* " == *' OPENCLAW_UPDATE_IN_PROGRESS=1 '* && " $* " == *' doctor --repair --non-interactive --no-workspace-suggestions '* ]] || return 92
  printf 'synthetic Doctor output\n'; printf 'synthetic Doctor error\n' >&2; return 17
}
${source.slice(start, end)}
printf '%s' "$doctor_exit"
`, "fixture", f.log], { encoding: "utf8", timeout: 5000 });
  assert.equal(f.ok(result), "17");
  assert.match(fs.readFileSync(f.log + ".stdout", "utf8"), /OPENCLAW_TEAM_DOCTOR_ATTEMPT [^\n]+\nsynthetic Doctor output\n$/);
  assert.match(fs.readFileSync(f.log + ".stderr", "utf8"), /OPENCLAW_TEAM_DOCTOR_ATTEMPT [^\n]+\nsynthetic Doctor error\n$/);
  assert.deepEqual(intent.logs.map(log => log.inode), [".stdout", ".stderr"].map(suffix => fs.statSync(f.log + suffix).ino));
});

for (const legacy of [false, true]) test(`pre-Doctor recovery resumes after binding attachment (${legacy ? "legacy capture without lsattr" : "current capture"})`, t => {
  const f = fixture(t, { pausePrepared: true, preexisting: false });
  f.ok(f.run("migration-transition", [f.journal, f.serving, JSON.stringify(f.load()), "@stdin"], '{"phase":"doctor-started"}'));
  if (legacy) {
    f.replaceArtifact("precapture", f.artifact("precapture").directories.map(({ directory, entries }) => ({ directory, entries })));
    fs.writeFileSync(f.filesystemOverrides, JSON.stringify(Object.fromEntries([f.shared, f.agent].map(path => [dirname(path), { unavailable: true }]))));
  }
  const inventory = f.artifact("inventory"), record = f.load().record;
  const binding = { version: 1, directories: [], databases: inventory.stores.map(store => ({ path: store.path,
    old: { device: store.device, inode: store.inode }, new: { device: store.device, inode: store.inode }, recovery: "unchanged-before-doctor" })) };
  const name = `rebinding-${randomUUID()}.json`, path = join(f.serving, "journal", record.agentMigration.stage, name);
  fs.writeFileSync(path, JSON.stringify(binding), { mode: 0o600 });
  const entry = fs.statSync(path);
  record.agentMigration.artifacts.rebinding = { name, device: entry.dev, inode: entry.ino, sha256: createHash("sha256").update(fs.readFileSync(path)).digest("hex") };
  fs.writeFileSync(f.journal, JSON.stringify(record));
  assert.notEqual(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]).status, 0);
  assert.equal(fs.existsSync(f.permit), false);
  f.ok(f.command("offline-doctor-recover", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(f.load().record.agentMigration.phase, "recovering-predecessor");
  fs.unlinkSync(join(f.serving, "current")); fs.symlinkSync(f.initial, join(f.serving, "current")); fs.unlinkSync(join(f.serving, "previous"));
  f.ok(f.command("offline-recovery-permit", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(fs.existsSync(f.permit), true);
});


test("a verified attempt cannot append a new marker before stores verification", t => {
  const f = fixture(t, { crossing: true }); migrateShared(f); f.ok(f.verify());
  const bytes = [".stdout", ".stderr"].map(suffix => fs.readFileSync(f.log + suffix));
  const result = f.command("offline-doctor-intent", [f.log, f.env.OPENCLAW_TEAM_PROC_ROOT]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /cannot restart after identity verification/);
  for (const [index, suffix] of [".stdout", ".stderr"].entries()) assert.deepEqual(fs.readFileSync(f.log + suffix), bytes[index]);
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
});

function partialRefusal(t) {
  const f = fixture(t, { crossing: true, auxiliary: true, preexisting: false });
  f.rewrite(dirname(f.shared)); migrateShared(f);
  fs.appendFileSync(f.log + ".stderr", `SQLite NOCOW repair refused for ${dirname(f.agent)}: synthetic busy directory.\n`);
  assert.notEqual(f.verify(17).status, 0);
  assert.equal(fs.existsSync(f.permit), false);
  f.retry = () => {
    f.ok(f.command("offline-doctor-capture", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
    return f.command("offline-doctor-intent", [join(dirname(f.log), "doctor-20261001T120000Z-999"), f.env.OPENCLAW_TEAM_PROC_ROOT]);
  };
  return f;
}

test("explicit forward retry judges the new attempt and retains the historical refusal and receipts", t => {
  const f = partialRefusal(t);
  const original = Object.fromEntries(["inventory", "backups", "witness", "precapture", "nocow", "failure"].map(kind => [kind, f.artifact(kind)]));
  const logPrefixes = [".stdout", ".stderr"].map(suffix => fs.readFileSync(f.log + suffix));
  const doctorPath = join(dirname(f.log), f.load().record.agentMigration.artifacts.doctor.name), doctorBytes = fs.readFileSync(doctorPath);
  f.ok(f.retry());
  assert.equal(f.ok(f.command("offline-doctor-log", [f.env.OPENCLAW_TEAM_PROC_ROOT])), f.log);
  f.rewrite(dirname(f.agent)); f.ok(f.verify());
  const binding = f.artifact("rebinding");
  assert.deepEqual(binding.directories.map(row => row.nocow), ["rewritten", "rewritten"]);
  assert.equal(binding.directories.find(row => row.path === dirname(f.shared)).receipt.attempt, 1);
  assert.equal(binding.directories.find(row => row.path === dirname(f.agent)).receipt.attempt, 2);
  assert.deepEqual(binding.priorRefusals, [{ index: 1, startedAt: f.artifact("doctor").attempts[0].startedAt, messages: ["NOCOW repair refused"] }]);
  assert.deepEqual(f.artifact("doctor").attempts.map(({ index, exit }) => ({ index, exit })), [{ index: 1, exit: 17 }, { index: 2, exit: 0 }]);
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  assert.equal(fs.existsSync(f.permit), true);
  assert.equal(f.load().record.agentMigration.phase, "stores-verified");
  assert.equal(f.load().record.phase, "D_VERIFYING");
  for (const [kind, value] of Object.entries(original)) assert.deepEqual(f.artifact(kind), value);
  assert.deepEqual(fs.readFileSync(doctorPath), doctorBytes);
  for (const [index, suffix] of [".stdout", ".stderr"].entries())
    assert.deepEqual(fs.readFileSync(f.log + suffix).subarray(0, logPrefixes[index].length), logPrefixes[index]);
});

for (const output of ["SQLite NOCOW repair refused for agent: busy", "│ SQLite NOCOW repair │\n│ skipped: unavailable │"])
test(`a current retry refusal still fences the candidate: ${output}`, t => {
  const f = partialRefusal(t), failure = f.artifact("failure");
  f.ok(f.retry()); f.rewrite(dirname(f.agent)); fs.appendFileSync(f.log + ".stderr", output);
  const result = f.verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, /refused or needs inspection/);
  assert.deepEqual(f.artifact("failure"), failure);
  assert.equal(fs.existsSync(f.permit), false);
});

for (const change of ["missing marker", "tampered marker", "historical bytes", "legacy intent", "artifact mutation", "receipt inode", "missing C", "missing receipt"])
test(`forward retry refuses ${change}`, t => {
  const f = partialRefusal(t);
  if (change === "legacy intent") {
    const { log, logs } = f.artifact("doctor"); f.replaceArtifact("doctor", { version: 1, log, logs });
    const result = f.retry(); assert.notEqual(result.status, 0); assert.match(result.stderr, /lacks a bound attempt marker/);
  } else {
    f.ok(f.retry());
    if (change !== "missing C") {
      const rewrite = f.rewrite(dirname(f.agent), change !== "missing receipt");
      if (change === "missing receipt") fs.rmdirSync(rewrite.snapshots);
    }
    const path = f.log + ".stderr", attempt = f.artifact("doctor").attempts.at(-1), content = fs.readFileSync(path, "utf8");
    let pattern;
    if (change === "missing marker") {
      fs.writeFileSync(path, content.slice(0, attempt.logs[1].offset)); pattern = /attempt marker is missing or changed/;
    } else if (change === "tampered marker") {
      fs.writeFileSync(path, content.slice(0, attempt.logs[1].offset) + content.slice(attempt.logs[1].offset).replace('"index":2', '"index":9'));
      pattern = /attempt marker is missing or changed/;
    } else if (change === "historical bytes") {
      fs.writeFileSync(path, content.replace("synthetic busy", "synthetic lazy")); pattern = /attempt log hash changed/;
    } else if (change === "artifact mutation") {
      const artifactPath = join(dirname(f.log), f.load().record.agentMigration.artifacts.doctor.name);
      fs.appendFileSync(artifactPath, " "); pattern = /bound migration doctor artifact changed/;
    } else if (change === "receipt inode") {
      const directory = dirname(f.shared), copy = directory + ".unreceipted";
      copyStore(directory, copy); fs.renameSync(directory, directory + ".removed"); fs.renameSync(copy, directory);
      pattern = /receipt directory identity changed/;
    } else if (change === "missing C") pattern = /NOCOW rewrite did not happen/;
    else pattern = /exactly one snapshots sibling/;
    // Artifact tampering prevents even loading the bound record, so call with the last valid evidence.
    const result = change === "artifact mutation"
      ? f.run("offline-doctor-verify", [f.journal, f.serving, "{}", 0, f.env.OPENCLAW_TEAM_PROC_ROOT]) : f.verify();
    assert.notEqual(result.status, 0); assert.match(result.stderr, pattern);
  }
  assert.equal(fs.existsSync(f.permit), false);
});


for (const boundary of ["neither marker", "one marker", "partial marker", "both markers", "corrupt marker"])
test(`explicit retry resumes durable preparing intent after ${boundary}`, t => {
  const f = partialRefusal(t); f.ok(f.retry());
  const doctor = f.artifact("doctor"), attempt = doctor.attempts.at(-1);
  attempt.markerState = "preparing"; f.replaceArtifact("doctor", doctor);
  for (const [stream, suffix] of [".stdout", ".stderr"].entries()) {
    const path = f.log + suffix, bytes = fs.readFileSync(path), offset = attempt.logs[stream].offset;
    const keep = boundary === "both markers" || (boundary === "one marker" && stream === 0) ? bytes.length :
      boundary === "partial marker" ? offset + 7 : offset;
    fs.writeFileSync(path, bytes.subarray(0, keep));
  }
  if (boundary === "corrupt marker") fs.appendFileSync(f.log + ".stderr", "unexpected");
  const before = [".stdout", ".stderr"].map(suffix => fs.readFileSync(f.log + suffix));
  const result = f.retry();
  if (boundary === "corrupt marker") {
    assert.notEqual(result.status, 0); assert.match(result.stderr, /preparing attempt marker or historical log bytes changed/);
    assert.equal(fs.existsSync(f.permit), false); return;
  }
  f.ok(result);
  assert.equal(f.artifact("doctor").attempts.length, 2);
  assert.equal(f.artifact("doctor").attempts.at(-1).markerState, "ready");
  for (const [stream, suffix] of [".stdout", ".stderr"].entries())
    assert.deepEqual(fs.readFileSync(f.log + suffix).subarray(0, before[stream].length), before[stream]);
  f.rewrite(dirname(f.agent)); f.ok(f.verify());
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
});

function liveReconciliationFixture(t) {
  const f = fixture(t, { crossing: true, preexisting: false, fiveAgents: true, auxiliary: true,
    beforeCold({ shared }) {
      const db = new DatabaseSync(shared);
      db.exec("CREATE TABLE diagnostic_events(scope TEXT,event_key TEXT,sequence INTEGER,payload_json TEXT)");
      db.close();
    } });
  partialDoctor(f);
  f.ok(f.command("offline-doctor-accept-partial", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  f.ok(f.command("migration-verify-stores", [f.config, f.shared]));
  f.ok(f.command("migration-permit-publish", [f.env.OPENCLAW_TEAM_PROC_ROOT]));
  const processBinding = { pid: 222, generation: "2220", instance: "candidate-instance-222" };
  const processPath = join(f.env.OPENCLAW_TEAM_PROC_ROOT, "222");
  fs.mkdirSync(processPath);
  const fields = Array(24).fill("0"); fields[0] = "S"; fields[19] = "2220";
  fs.writeFileSync(join(processPath, "stat"), `222 (fixture gateway) ${fields.join(" ")}\n`);
  fs.symlinkSync(f.candidate, join(processPath, "cwd"));
  const original = f.load(), previous = f.artifact("inventory").config;
  const replacement = JSON.parse(fs.readFileSync(f.config));
  replacement.agents.entries["controller-test-agent"].model = "fixture/replacement-model";
  replacement.channels.reef = { guard: { pinnedModel: "replacement-model" } };
  fs.writeFileSync(f.config + ".next", JSON.stringify(replacement), { mode: 0o600 });
  fs.renameSync(f.config + ".next", f.config);
  const metadata = fs.statSync(f.config), bytes = fs.readFileSync(f.config);
  const configHash = createHash("sha256").update(bytes).digest("hex");
  const ts = new Date().toISOString();
  const audit = { ts, event: "config.write", source: "config-io", result: "rename", configPath: f.config,
    existsBefore: true, pid: 333, previousHash: previous.sha256, nextHash: configHash,
    previousBytes: previous.size, nextBytes: bytes.length };
  for (const [prefix, descriptor] of [["previous", previous], ["next", { device: metadata.dev, inode: metadata.ino }]])
    Object.assign(audit, { [prefix + "Dev"]: String(descriptor.device), [prefix + "Ino"]: String(descriptor.inode),
      [prefix + "Mode"]: 0o600, [prefix + "Nlink"]: 1, [prefix + "Uid"]: process.getuid(), [prefix + "Gid"]: process.getgid() });
  const db = new DatabaseSync(f.shared);
  db.prepare("INSERT INTO diagnostic_events VALUES('config-audit',?,1,?)").run(`${ts}:config.write:${randomUUID()}`, JSON.stringify(audit));
  db.close();
  const request = { candidate: "b".repeat(40), process: processBinding, runtimeUid: process.getuid(), configSha256: configHash, journalSha256: original.identity.sha256 };
  const snapshot = () => f.run("migration-reconcile-snapshot", [f.journal, f.serving, JSON.stringify(f.load()), JSON.stringify(request)]);
  const commit = value => f.run("migration-reconcile-commit", [f.journal, f.serving, JSON.stringify(original), JSON.stringify(value)]);
  return { ...f, original, request, snapshot, commit, processPath };
}

function runLiveReconciliation(f, { ordinary = false, failure = "" } = {}) {
  const source = fs.readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
  const extract = (name, next) => source.slice(source.indexOf(`${name}() {`), source.indexOf(`\n${next}() {`));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const events = join(f.root, "live-events"), script = join(f.root, "live-reconcile.sh");
  fs.writeFileSync(events, "");
  fs.writeFileSync(script, `#!/usr/bin/env bash
set -euo pipefail
mode=recover; reconcile_stopped=0; accept_partial_nocow=0; migration_recovered=0
journal_file=${quote(f.journal)}; serving_root=${quote(f.serving)}; releases_root="$serving_root/releases"
config_file=${quote(f.config)}; state_database=${quote(f.shared)}; proc_root=${quote(f.env.OPENCLAW_TEAM_PROC_ROOT)}
root_uid=${process.getuid()}; runtime_uid=${process.getuid()}; node_bin=${quote(process.execPath)}
reconcile_config_hash=${quote(ordinary ? "" : f.request.configSha256)}; reconcile_journal_hash=${quote(f.request.journalSha256)}
operator_expected_sha=${quote(f.request.candidate)}; operator_expected_pid=${f.request.process.pid}; operator_expected_generation=${quote(f.request.process.generation)}
session_witness=""; verification_budget=1
proof() { "$node_bin" --no-warnings --import ${quote(join(f.root, "native-probes.mjs"))} ${quote(library)} "$@"; }
fail() { echo "$*" >&2; return 1; }
operator_check_lock() { [[ "$1" == held ]]; }
migration_check_guard() { proof migration-check "$journal_file" "$serving_root" "$migration_evidence" >/dev/null; }
read_process_instance() { [[ "$1" == ${quote(f.candidate)} && "$2" == 222 ]]; echo candidate-instance-222; }
capture_service_generation() { service_pid=222; service_generation=2220; }
recheck_generation() { [[ "$*" == 'system 222 2220' ]]; }
assert_protected_identity() { [[ "$(proof fingerprint "$config_file" "$state_database")" == "$protected_identity" ]]; }
assert_policy() { [[ "$(proof policy "$config_file")" == "$policy_identity" ]]; }
verify_convergence() { echo probes-channels >>${quote(events)}; [[ ${quote(failure)} != probes ]]; }
verify_marker() { echo marker >>${quote(events)}; ${failure === "generation" ? 'sed -i.bak s/2220/9999/ "$proc_root/222/stat"' : ":"}; }
verification_failure() { echo verification-failed >&2; }
verified_markers() { [[ "$*" == 'record ${"b".repeat(40)}' ]]; echo verified-marker >>${quote(events)}; }
system_systemctl() { echo forbidden-service-action >>${quote(events)}; return 99; }
cleanup_releases() { echo forbidden-cleanup >>${quote(events)}; return 99; }
recover_agent_schema_migration() { echo forbidden-migration-retry >>${quote(events)}; return 99; }
${extract("wait_for_live", "migration_native_guard")}
${extract("recover_live_migration_candidate", "recover_agent_schema_migration")}
${extract("recover_journal", "freeze_origin_main")}
recover_journal
`, { mode: 0o700 });
  const result = spawnSync(f.realCommands.bash, [script], { env: f.env, encoding: "utf8", timeout: 30000 });
  assert.doesNotMatch(fs.readFileSync(events, "utf8"), /forbidden/);
  return { ...result, events: fs.readFileSync(events, "utf8") };
}

test("live selected partial-NOCOW candidate reconciles native config and finishes without service actions", t => {
  const f = liveReconciliationFixture(t), artifacts = structuredClone(f.original.record.agentMigration.artifacts);
  const result = runLiveReconciliation(f); f.ok(result);
  assert.match(result.stdout, /RECOVERY_CONFIG_RECONCILED .*restart=0/);
  assert.match(result.stdout, /SUCCESS sha=b{40} action=deploy migration=state-19-20\+nocow previous=a{40} .*nocow=partial refused=5/);
  assert.equal(result.events, "probes-channels\nmarker\nverified-marker\n");
  assert.equal(fs.existsSync(f.journal), false);
  const stage = f.original.identity.stage.path;
  const receipt = JSON.parse(fs.readFileSync(join(stage, fs.readdirSync(stage).find(name => name.startsWith("reconciliation-")))));
  assert.deepEqual(receipt.original, f.original);
  assert.deepEqual(receipt.original.record.agentMigration.artifacts, artifacts);
  for (const descriptor of Object.values(artifacts))
    assert.equal(createHash("sha256").update(fs.readFileSync(join(stage, descriptor.name))).digest("hex"), descriptor.sha256);
  assert.equal(fs.existsSync(f.permit), true);
});

for (const [name, change, pattern] of [
  ["no native audit", f => { const db = new DatabaseSync(f.shared); db.exec("DELETE FROM diagnostic_events"); db.close(); }, /native runtime-owner atomic replacement audit/],
  ["non-rename native audit", f => { const db = new DatabaseSync(f.shared); const row = db.prepare("SELECT payload_json FROM diagnostic_events").get(); const audit = JSON.parse(row.payload_json); audit.result = "write"; db.prepare("UPDATE diagnostic_events SET payload_json=?").run(JSON.stringify(audit)); db.close(); }, /native runtime-owner atomic replacement audit/],
  ["foreign runtime owner", f => { f.request.runtimeUid++; }, /owner-safe/],
  ["config hash mismatch", f => { f.request.configSha256 = "0".repeat(64); }, /config hash mismatch/],
  ["journal hash mismatch", f => { f.request.journalSha256 = "0".repeat(64); }, /journal hash mismatch/],
  ["different candidate", f => { f.request.candidate = "c".repeat(40); }, /candidate.*mismatch/],
  ["candidate not current", f => { fs.unlinkSync(join(f.serving, "current")); fs.symlinkSync(f.initial, join(f.serving, "current")); }, /current pointer identity changed/],
  ["Gateway generation differs", f => { f.request.process.generation = "9999"; }, /Gateway generation changed/],
  ["Gateway cwd differs", f => { fs.unlinkSync(join(f.processPath, "cwd")); fs.symlinkSync(f.initial, join(f.processPath, "cwd")); }, /Gateway generation changed/],
  ["store identity changed", f => { fs.copyFileSync(f.agent, f.agent + ".next"); fs.renameSync(f.agent + ".next", f.agent); }, /store identity changed since NOCOW rebinding/],
  ["target schema changed", f => { const db = new DatabaseSync(f.shared); db.exec("PRAGMA user_version=19; UPDATE schema_meta SET schema_version=19"); db.close(); }, /schema.*(unsupported|metadata|declared|version)|unqualified/],
  ["permit missing", f => { fs.unlinkSync(f.permit); }, /existing start permit/],
  ["Doctor-started phase", f => { const r = f.load().record; r.phase = "C_CURRENT_SELECTED"; r.agentMigration.phase = "doctor-started"; fs.writeFileSync(f.journal, JSON.stringify(r)); f.request.journalSha256 = f.load().identity.sha256; }, /D_VERIFYING\/stores-verified/],
]) test(`live candidate config reconciliation refuses ${name} without mutation`, t => {
  const f = liveReconciliationFixture(t); change(f);
  const bytes = fs.readFileSync(f.journal), result = f.snapshot();
  assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, pattern);
  assert.deepEqual(fs.readFileSync(f.journal), bytes);
  assert.equal(f.load().record.agentMigration.artifacts.reconciliation, undefined);
});

for (const drift of ["journal", "config", "process", "pointer", "store", "permit"])
test(`live reconciliation compare-and-swap refuses ${drift} drift`, t => {
  const f = liveReconciliationFixture(t), snapshot = JSON.parse(f.ok(f.snapshot()));
  if (drift === "journal") fs.appendFileSync(f.journal, " ");
  if (drift === "config") fs.appendFileSync(f.config, " ");
  if (drift === "process") fs.writeFileSync(join(f.processPath, "stat"), fs.readFileSync(join(f.processPath, "stat"), "utf8").replace("2220", "9999"));
  if (drift === "pointer") { const path = join(f.serving, "current"); fs.renameSync(path, path + ".old"); fs.symlinkSync(f.candidate, path); }
  if (drift === "store") { fs.copyFileSync(f.agent, f.agent + ".next"); fs.renameSync(f.agent + ".next", f.agent); }
  if (drift === "permit") fs.unlinkSync(f.permit);
  const bytes = fs.readFileSync(f.journal), result = f.commit(snapshot);
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(fs.readFileSync(f.journal), bytes);
});

test("live candidate failed channel acceptance retains reconciliation and ordinary recovery finishes without restart", t => {
  const f = liveReconciliationFixture(t), failed = runLiveReconciliation(f, { failure: "probes" });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /verification failed; journal and evidence retained, no service action/);
  assert.doesNotMatch(failed.stdout, /SUCCESS/);
  const evidence = f.load();
  assert.equal(evidence.record.phase, "D_VERIFYING");
  assert.equal(evidence.record.protectedPaths[0].inode, fs.statSync(f.config).ino);
  assert.deepEqual(evidence.record.agentMigration.artifacts.rebinding, f.original.record.agentMigration.artifacts.rebinding);
  const result = runLiveReconciliation(f, { ordinary: true }); f.ok(result);
  assert.match(result.stdout, /SUCCESS .*nocow=partial refused=5/);
  assert.equal(fs.existsSync(f.journal), false);
});

test("live candidate generation drift during acceptance retains the rebound journal", t => {
  const f = liveReconciliationFixture(t), result = runLiveReconciliation(f, { failure: "generation" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Gateway generation changed/);
  assert.doesNotMatch(result.stdout, /SUCCESS/); assert.equal(fs.existsSync(f.journal), true);
});

// Ordinary startup replacement uses the real journal/audit proofs without Linux services.
function startupConfigFixture(t, { phase = "ROLLBACK_FAILED", change } = {}) {
  const f = makeReleaseFixture(t), candidate = f.addRelease("b".repeat(40));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const run = (cmd, args = []) => spawnSync(process.execPath, ["--no-warnings", library, cmd, ...args.map(String)],
    { env: f.env, encoding: "utf8", timeout: 30000 });
  const ok = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const proof = (cmd, args = []) => ok(run(cmd, args));
  const info = [];
  for (const [release, sha] of [[f.initial, f.sha], [candidate, "b".repeat(40)]]) {
    fs.chmodSync(release, 0o755); fs.chmodSync(join(release, "node_modules"), 0o755);
    fs.mkdirSync(join(release, "node_modules/sqlite-vec"));
    fs.writeFileSync(join(release, "node_modules/sqlite-vec/index.js"), "exports.load=db=>db.function('vec_version',()=> 'fixture');");
    proof("manifest", [release, sha, process.getuid(), sha]); proof("seal-tree", [release]);
    info.push(JSON.parse(proof("validate-release", [release, sha, process.getuid(), "sealed"])));
  }
  const before = JSON.parse(fs.readFileSync(f.config));
  before.channels["nextcloud-talk"] = { accounts: { default: { enabled: true } } };
  fs.writeFileSync(f.config, JSON.stringify(before));
  const paths = JSON.parse(proof("fingerprint", [f.config, f.databasePath]));
  const previousBytes = fs.readFileSync(f.config), originalPolicy = JSON.parse(proof("policy", [f.config]));
  const witness = join(dirname(f.journal), `original-${randomUUID()}.json`);
  fs.writeFileSync(witness, "[]", { mode: 0o600 });
  const witnessStat = fs.statSync(witness);
  const record = { version: 1, phase, topology: "system", predecessor: info[0], candidate: info[1],
    createdAt: new Date(Date.now() - 60000).toISOString(),
    process: { pid: 111, generation: "1110", instance: "fixture-original" },
    protectedPaths: paths, originalWitness: { name: witness.split("/").at(-1), device: witnessStat.dev,
      inode: witnessStat.ino, sha256: hash("[]") },
    pointerTopology: { current: { present: true, sha: f.sha }, previous: { present: false, sha: null } },
    services: { system: { unitFileState: "enabled", activeState: "active" }, user: { unitFileState: "disabled", activeState: "inactive" } },
    suspension: { id: randomUUID(), expiresAtMs: Date.now() - 1000, terminalPolicy: "preserve", status: "draining" } };
  fs.writeFileSync(f.journal, JSON.stringify(record), { mode: 0o600 });
  fs.unlinkSync(join(f.serving, "current")); fs.symlinkSync(candidate, join(f.serving, "current"));
  fs.symlinkSync(f.initial, join(f.serving, "previous"));
  const processPath = join(f.env.OPENCLAW_TEAM_PROC_ROOT, "222"), binding = { pid: 222, generation: "2220" };
  fs.mkdirSync(processPath);
  const fields = Array(24).fill("0"); fields[0] = "S"; fields[19] = binding.generation;
  fs.writeFileSync(join(processPath, "stat"), `222 (fixture gateway) ${fields.join(" ")}\n`);
  fs.symlinkSync(candidate, join(processPath, "cwd"));
  const ticks = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim());
  fs.writeFileSync(join(f.env.OPENCLAW_TEAM_PROC_ROOT, "stat"), `btime ${Math.floor(Date.now() / 1000 - 33 - 2220 / ticks)}\n`);
  const next = structuredClone(before);
  next.meta.migrations.webhookListeners = { feishu: true, msteams: true, "nextcloud-talk": true, telegram: true };
  next.channels["nextcloud-talk"].accounts.default.legacyWebhook = { host: "127.0.0.1", port: 1234 };
  change?.(next);
  fs.copyFileSync(f.config, f.config + ".bak"); fs.chmodSync(f.config + ".bak", 0o600);
  fs.writeFileSync(f.config + ".next", JSON.stringify(next), { mode: 0o600 }); fs.renameSync(f.config + ".next", f.config);
  const entry = fs.statSync(f.config), bytes = fs.readFileSync(f.config), ts = new Date().toISOString();
  const audit = { ts, event: "config.write", source: "config-io", result: "rename", configPath: f.config,
    existsBefore: true, pid: binding.pid, previousHash: hash(previousBytes), nextHash: hash(bytes),
    previousBytes: previousBytes.length, nextBytes: bytes.length };
  for (const [prefix, descriptor] of [["previous", paths[0]], ["next", { device: entry.dev, inode: entry.ino }]])
    Object.assign(audit, { [prefix + "Dev"]: String(descriptor.device), [prefix + "Ino"]: String(descriptor.inode),
      [prefix + "Mode"]: 0o600, [prefix + "Nlink"]: 1, [prefix + "Uid"]: process.getuid(), [prefix + "Gid"]: process.getgid() });
  const db = new DatabaseSync(f.databasePath);
  db.exec("CREATE TABLE diagnostic_events(scope TEXT,event_key TEXT,sequence INTEGER,payload_json TEXT)");
  db.prepare("INSERT INTO diagnostic_events VALUES('config-audit',?,1,?)").run(`${ts}:config.write:${randomUUID()}`, JSON.stringify(audit));
  db.close();
  const request = { config: { path: f.config, sha256: hash(bytes) }, journalSha256: hash(fs.readFileSync(f.journal)),
    databasePath: f.databasePath, runtimeUid: process.getuid(), process: binding };
  const updateAudit = change => {
    const db = new DatabaseSync(f.databasePath), row = db.prepare("SELECT payload_json FROM diagnostic_events").get();
    const value = JSON.parse(row.payload_json); change(value);
    db.prepare("UPDATE diagnostic_events SET event_key=?,payload_json=?").run(`${value.ts}:config.write:fixture`, JSON.stringify(value)); db.close();
  };
  const snapshot = () => run("recovery-snapshot", [f.journal, f.serving, JSON.stringify(record), "selected", JSON.stringify(request)]);
  const accept = () => run("candidate-config-accept", [f.journal, f.serving, JSON.stringify(paths), binding.pid,
    binding.generation, request.runtimeUid, JSON.stringify(originalPolicy)]);
  return { ...f, candidate, record, paths, originalPolicy, processPath, binding, request, run, ok, proof, snapshot, accept, updateAudit };
}

function runSelectedConfigRecovery(f, { failure = "", deploy = false } = {}) {
  const source = fs.readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
  const declarations = [...source.matchAll(/^([a-zA-Z_][a-zA-Z_0-9]*)\(\) \{/gm)];
  const extract = name => { const i = declarations.findIndex(m => m[1] === name); assert.notEqual(i, -1);
    return source.slice(declarations[i].index, declarations[i + 1]?.index ?? source.length); };
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const events = join(f.root, "config-events"), script = join(f.root, "config-recovery.sh");
  fs.writeFileSync(events, "");
  fs.writeFileSync(script, `set -euo pipefail
mode=${deploy ? "deploy" : "recover"}; reconcile_stopped=0; accept_partial_nocow=0
reconcile_config_hash=${quote(deploy ? "" : f.request.config.sha256)}; reconcile_journal_hash=${quote(f.request.journalSha256)}
reconcile_request=""; reconcile_evidence=""; reconcile_position=restored; session_witness=""; session_witness_record=""
journal_file=${quote(f.journal)}; serving_root=${quote(f.serving)}; releases_root="$serving_root/releases"; current_link="$serving_root/current"
config_file=${quote(f.config)}; state_database=${quote(f.databasePath)}; proc_root=${quote(f.env.OPENCLAW_TEAM_PROC_ROOT)}
root_uid=${process.getuid()}; runtime_uid=${f.request.runtimeUid}; node_bin=${quote(process.execPath)}
operator_expected_sha=${quote(f.record.candidate.sha)}; operator_expected_pid=${f.request.process.pid}; operator_expected_generation=${quote(f.request.process.generation)}
policy_identity=${quote(JSON.stringify(f.originalPolicy))}; protected_identity=${quote(JSON.stringify(f.paths))}
candidate_release=${quote(f.candidate)}; candidate_info=${quote(JSON.stringify(f.record.candidate))}
suspension_pid=222; suspension_generation=2220
verification_budget=1
proof() {
  if [[ "$1" == compatibility ]]; then echo compatibility >>${quote(events)}; return 0; fi
  "$node_bin" --no-warnings ${quote(library)} "$@"
}
fail() { echo "$*" >&2; return 1; }
migration_check_existing_guard() { :; }
read_pointer() { readlink "$1"; }
capture_generation() { service_pid=222; service_generation=2220; }
capture_service_generation() { capture_generation; }
recheck_generation() { [[ "$*" == 'system 222 2220' ]]; }
verify_convergence() {
  verified_pid=222; verified_generation=2220
  assert_protected_identity && assert_policy || return 1
  echo probes-channels >>${quote(events)}
  [[ ${quote(failure)} != probes ]]
}
verify_marker() {
  echo marker-approvals-original-session >>${quote(events)}
  [[ "$session_witness" == '[]' || "$mode" == deploy ]] || return 1
  if [[ ${quote(failure)} == generation ]]; then sed -i.bak s/2220/9999/ "$proc_root/222/stat"; fi
  if [[ ${quote(failure)} == config ]]; then echo ' ' >>"$config_file"; fi
}
verification_failure() { echo verification-failed >&2; }
verification_step() { shift; "$@"; }
verified_markers() { echo verified-markers >>${quote(events)}; }
system_systemctl() { echo forbidden-service-action >>${quote(events)}; return 99; }
bounded() { echo forbidden-service-action >>${quote(events)}; return 99; }
${["assert_protected_identity", "assert_policy", "load_journal_witness", "wait_for_live", "recover_journal", "verify_deployed_candidate"].map(extract).join("\n")}
${deploy ? "verify_deployed_candidate" : "recover_journal"}
`);
  const result = spawnSync(f.realCommands.bash, [script], { env: f.env, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.doesNotMatch(fs.readFileSync(events, "utf8"), /forbidden/);
  return { ...result, events: fs.readFileSync(events, "utf8") };
}

test("failed ordinary selected candidate reconciles audited config and retires exact journal without service action", t => {
  const f = startupConfigFixture(t), original = fs.readFileSync(f.journal), result = runSelectedConfigRecovery(f);
  f.ok(result);
  assert.match(result.stdout, /RECOVERED phase=ROLLBACK_FAILED action=verified-selected-candidate-reconciled-config/);
  assert.match(result.events, /probes-channels\nmarker-approvals-original-session/);
  assert.equal(fs.existsSync(f.journal), false);
  const receipt = JSON.parse(fs.readFileSync(join(dirname(f.journal), `config-reconciliation-${f.request.journalSha256}.json`)));
  assert.deepEqual(receipt.evidence.record, JSON.parse(original));
  assert.equal(receipt.evidence.configReconciliation.journalSha256, f.request.journalSha256);
  assert.equal(receipt.evidence.configReconciliation.config.sha256, f.request.config.sha256);
  assert.ok(receipt.evidence.identity.inode);
  assert.ok(receipt.evidence.configReconciliation.replacement.audit.sha256);
  assert.equal(fs.readlinkSync(join(f.serving, "current")), f.candidate);
});

for (const [name, change] of [
  ["identical predecessor", f => { f.record.predecessor = f.record.candidate; fs.writeFileSync(f.journal, JSON.stringify(f.record)); }],
  ["wrong PID", f => { f.request.process.pid = 333; }],
  ["wrong generation", f => { f.request.process.generation = "9999"; }],
  ["changed config hash", f => { f.request.config.sha256 = "0".repeat(64); }],
  ["replaced store", f => { fs.copyFileSync(f.databasePath, f.databasePath + ".next"); fs.renameSync(f.databasePath + ".next", f.databasePath); }],
  ["candidate no longer current", f => { fs.unlinkSync(join(f.serving, "current")); fs.symlinkSync(f.initial, join(f.serving, "current")); }],
  ["missing rename audit", f => f.updateAudit(value => { value.result = "write"; })],
  ["audit preimage inode drift", f => f.updateAudit(value => { value.previousIno = "1"; })],
  ["audit preimage size drift", f => f.updateAudit(value => { value.previousBytes++; })],
]) test(`ordinary selected reconciliation refuses ${name} and retains journal`, t => {
  const f = startupConfigFixture(t); change(f); const original = fs.readFileSync(f.journal);
  const proof = f.snapshot(); assert.notEqual(proof.status, 0, proof.stdout);
  const result = runSelectedConfigRecovery(f); assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(fs.readFileSync(f.journal), original);
  assert.equal(fs.existsSync(join(dirname(f.journal), `config-reconciliation-${f.request.journalSha256}.json`)), false);
});

for (const failure of ["probes", "generation", "config"])
test(`ordinary selected reconciliation retains original journal after ${failure} verification failure`, t => {
  const f = startupConfigFixture(t), original = fs.readFileSync(f.journal);
  assert.notEqual(runSelectedConfigRecovery(f, { failure }).status, 0);
  assert.deepEqual(fs.readFileSync(f.journal), original);
});

test("ordinary deploy accepts only audited candidate startup additions and durably rebinds config", t => {
  const f = startupConfigFixture(t, { phase: "D_VERIFYING" }), original = fs.readFileSync(f.journal);
  const result = runSelectedConfigRecovery(f, { deploy: true }); f.ok(result);
  assert.match(result.stdout, /CONFIG_MIGRATION_ACCEPTED keys=6 source=candidate-startup/);
  const record = JSON.parse(fs.readFileSync(f.journal));
  assert.equal(record.protectedPaths[0].inode, fs.statSync(f.config).ino);
  assert.deepEqual(record.protectedPaths[1], f.paths[1]);
  assert.deepEqual(record.originalWitness, f.record.originalWitness);
  const name = fs.readdirSync(dirname(f.journal)).find(name => name.startsWith("config-startup-"));
  const receipt = JSON.parse(fs.readFileSync(join(dirname(f.journal), name)));
  assert.deepEqual(receipt.original.record, JSON.parse(original));
  assert.equal(receipt.original.identity.sha256, f.request.journalSha256);
  assert.deepEqual(receipt.process, f.binding);
  f.proof("journal-read", [f.journal]);
});

for (const [name, change, mutate] of [
  ["removed key", next => { delete next.syntheticUnrelated; }],
  ["changed key", next => { next.syntheticUnrelated.retained = "changed"; }],
  ["new agent", next => { next.agents.entries.newAgent = {}; }],
  ["new plugin", next => { next.plugins.entries.newPlugin = { enabled: true }; }],
  ["new channel account", next => { next.channels["nextcloud-talk"].accounts.newAccount = { enabled: true }; }],
  ["changed policy", next => { next.agents.entries["controller-test-agent"].model.primary = "fixture/other-model"; }],
  ["foreign uid", null, f => f.updateAudit(value => { value.nextUid++; })],
  ["foreign gid", null, f => f.updateAudit(value => { value.previousGid++; })],
  ["missing rename", null, f => f.updateAudit(value => { value.result = "write"; })],
  ["another writer PID", null, f => f.updateAudit(value => { value.pid = 333; })],
  ["previous generation audit", null, f => f.updateAudit(value => { value.ts = new Date(Date.now() - 120000).toISOString(); })],
  ["missing backup", null, f => fs.unlinkSync(f.config + ".bak")],
  ["changed backup", null, f => fs.appendFileSync(f.config + ".bak", " ")],
  ["replaced store", null, f => { fs.copyFileSync(f.databasePath, f.databasePath + ".next"); fs.renameSync(f.databasePath + ".next", f.databasePath); }],
  ["reused PID", null, f => { fs.writeFileSync(join(f.processPath, "stat"), fs.readFileSync(join(f.processPath, "stat"), "utf8").replace("2220", "9999")); }],
]) test(`ordinary startup acceptance refuses ${name}`, t => {
  const f = startupConfigFixture(t, { phase: "D_VERIFYING", change }); mutate?.(f);
  const original = fs.readFileSync(f.journal), result = f.accept();
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(fs.readFileSync(f.journal), original);
  assert.doesNotMatch(result.stdout, /CONFIG_MIGRATION_ACCEPTED/);
});
