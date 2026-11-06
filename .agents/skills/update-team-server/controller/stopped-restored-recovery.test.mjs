import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { events, makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";

const candidateSha = "b".repeat(40);
const previousSha = "c".repeat(40);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function proof(f, args, input) {
  const result = spawnSync(process.execPath, ["--no-warnings", f.library, ...args.map(String)], {
    cwd: f.root, env: f.env, input, encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function setState(f, changes) {
  for (const [name, value] of Object.entries(changes)) writeFileSync(join(f.state, name), String(value));
}

function processEntry(f, pid, generation, release = f.initial) {
  const directory = join(f.root, "proc", String(pid));
  mkdirSync(directory, { recursive: true });
  const fields = Array.from({ length: 24 }, () => "0");
  fields[0] = "S"; fields[19] = String(generation);
  writeFileSync(join(directory, "stat"), `${pid} (fixture gateway) ${fields.join(" ")}\n`);
  symlinkSync(release, join(directory, "cwd"));
}

function fileSnapshot(paths) {
  return paths.map((file) => {
    const entry = lstatSync(file, { throwIfNoEntry: false });
    return [file, entry ? {
      dev: entry.dev, ino: entry.ino, mode: entry.mode, uid: entry.uid, gid: entry.gid,
      ...(entry.isSymbolicLink() ? { link: readlinkSync(file) } : {}),
      ...(entry.isFile() ? { sha256: digest(readFileSync(file)) } : {}),
    } : null];
  });
}

function observeBoundaries(f) {
  // These wrappers only record the real boundary, then forward to the existing
  // native library and service fixture. They never fabricate an admission result.
  const source = `
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const paths = ${JSON.stringify(f.protectedFiles)};
const snapshot = () => paths.map(file => {
  const s = fs.lstatSync(file, { throwIfNoEntry: false });
  return [file, s ? { dev:s.dev, ino:s.ino, mode:s.mode, uid:s.uid, gid:s.gid,
    ...(s.isSymbolicLink() ? {link:fs.readlinkSync(file)} : {}),
    ...(s.isFile() ? {sha256:createHash("sha256").update(fs.readFileSync(file)).digest("hex")} : {})
  } : null];
});
const args = process.argv.slice(2);
const event = value => fs.appendFileSync(${JSON.stringify(f.eventlog)}, value + "\\n");
`;
  const library = join(f.root, "observe-recovery-library.mjs");
  writeFileSync(library, source + `
const command = args[0];
event("proof." + command);
if (command === "recovery-finish") {
  fs.writeFileSync(${JSON.stringify(f.finishSnapshot)}, JSON.stringify(snapshot()));
  fs.writeFileSync(${JSON.stringify(f.finishArguments)}, JSON.stringify(args));
}
const result = spawnSync(process.execPath, ["--no-warnings", ${JSON.stringify(f.library)}, ...args], {stdio:"inherit"});
if (result.status === 0) event("proof." + command + ".ok");
process.exit(result.status ?? 1);
`);
  f.env.OPENCLAW_TEAM_RELEASE_LIB = library;
  const systemctl = join(f.root, "observe-recovery-systemctl.mjs");
  writeFileSync(systemctl, `#!${process.execPath}\n` + source + `
if (args[0] === "start") fs.writeFileSync(${JSON.stringify(f.startSnapshot)}, JSON.stringify(snapshot()));
const result = spawnSync(${JSON.stringify(f.commandPaths.systemctl)}, args, {stdio:"inherit"});
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  f.env.OPENCLAW_TEAM_SYSTEMCTL = systemctl;
}

function restoredFixture(t, { scenario = "success", groups = "absent" } = {}) {
  const f = makeReleaseFixture(t, scenario);
  const candidate = f.addRelease(candidateSha), previous = f.addRelease(previousSha);
  symlinkSync(previous, join(f.serving, "previous"));
  const predecessorInfo = proof(f, ["validate-release", f.initial, f.sha, process.getuid(), "sealed"]);
  const candidateInfo = proof(f, ["validate-release", candidate, candidateSha, process.getuid(), "sealed"]);
  const fingerprint = proof(f, ["fingerprint", f.configPath, f.databasePath]);
  const witness = proof(f, ["session-preservation-witness", f.initial, f.initial, f.databasePath]);
  proof(f, [
    "journal-create", f.journal, predecessorInfo, candidateInfo, "system", f.pid, f.start,
    `fixture-instance-${f.pid}`, fingerprint, f.sha, previousSha,
    "enabled", "active", "disabled", "inactive", randomUUID(), Date.now() + 60_000, "ready", "@stdin",
  ], witness);
  proof(f, ["journal-phase", f.journal, "ROLLBACK_FAILED", proof(f, ["journal-read", f.journal])]);
  const record = JSON.parse(readFileSync(f.journal, "utf8"));
  assert.ok(record.originalWitness, "ordinary recovery must retain its native original witness");
  f.originalWitness = join(f.serving, "journal", record.originalWitness.name);
  f.systemGroup = "/system.slice/openclaw-gateway.service";
  f.cgroup = (group) => join(f.root, "sys/fs/cgroup", group);
  setState(f, {
    system: "failed", user: "inactive", pid: 0, "user-pid": 0, "listener-pid": 0,
    "system-control-pid": 0, "user-control-pid": 0, "system-job": 0, "user-job": 0,
    "system-exec-main-pid": 222, "system-exec-start-monotonic": 2220000,
    "system-invocation-id": "2".repeat(32), "user-exec-main-pid": 0,
    "user-exec-start-monotonic": 0, "user-invocation-id": "",
    "system-control-group": f.systemGroup, "user-control-group": "", "system-slice": "system.slice",
  });
  rmSync(join(f.root, "proc", String(f.pid)), { recursive: true });
  if (groups === "empty") {
    mkdirSync(f.cgroup(f.systemGroup), { recursive: true, mode: 0o755 });
    chmodSync(f.cgroup(f.systemGroup), 0o755);
    for (const control of ["cgroup.procs", "cgroup.threads", "cgroup.subtree_control", "cgroup.events"]) {
      const file = join(f.cgroup(f.systemGroup), control);
      writeFileSync(file, control === "cgroup.events" ? "populated 0\nfrozen 0\n" : "", { mode: 0o644 });
      chmodSync(file, 0o644);
    }
  }
  f.protectedFiles = [
    f.journal, f.originalWitness, f.configPath, f.databasePath, f.agentDatabasePath,
    join(f.serving, "current"), join(f.serving, "previous"), f.guard, f.permit,
  ];
  f.startSnapshot = join(f.state, "recovery-before-start.json");
  f.finishSnapshot = join(f.state, "recovery-before-finish.json");
  f.finishArguments = join(f.state, "recovery-finish-arguments.json");
  observeBoundaries(f);
  return f;
}

function assertNoOtherMutation(f) {
  assert.doesNotMatch(events(f), /service\.(?:system|user)\.(?:stop|restart|enable|disable|daemon-reload)\n/);
  assert.doesNotMatch(events(f), /service\.user\.start|account\.openclaw-deploy|gateway config set/);
  assert.doesNotMatch(events(f), /proof\.(?:migration-permit-publish|migration-permit-revoke|migration-guard-install|journal-phase)\n/);
}

function assertRefusedBeforeStart(f, result, before) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /RECOVERED|MARKER_VERIFIED/);
  assert.doesNotMatch(result.stderr, /ROLLED_BACK/);
  assert.doesNotMatch(events(f), /service\.system\.start|gateway gateway call agent\n|proof\.recovery-finish/);
  assert.deepEqual(fileSnapshot(f.protectedFiles), before);
  assertNoOtherMutation(f);
}

function assertFullVerification(f) {
  const trace = events(f).split("\n");
  for (const event of [
    "probe.healthz", "probe.startupz", "gateway gateway status", "probe.readyz",
    "gateway gateway call channels.status", "gateway gateway call update.status",
    "proof.session-preservation-verify.ok", "gateway gateway call agent", "gateway gateway call agent.wait",
    "proof.recovery-check.ok", "proof.recovery-finish.ok",
  ]) assert.ok(trace.includes(event), `missing full verification boundary: ${event}`);
  const finish = trace.indexOf("proof.recovery-finish");
  assert.ok(finish > trace.indexOf("gateway gateway call agent.wait"));
  assert.equal(trace.filter((event) => event === "gateway gateway call agent").length, 1);
  assert.equal(trace.filter((event) => event === "proof.recovery-finish.ok").length, 1);
}

for (const groups of ["absent", "empty"]) {
  test(`stopped restored recovery starts current once with ${groups} system cgroup and completes full verification`, (t) => {
    const f = restoredFixture(t, { groups }), before = fileSnapshot(f.protectedFiles);
    t.diagnostic(`account routing=${f.accountMode}; lock=${f.lockMode}; proc/cgroups/systemd are synthetic`);
    const result = runOwner(f, ["--recover"]);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, /RECOVERED phase=ROLLBACK_FAILED/);
    assert.match(result.stdout, /session-proof=original-pre-cutover/);
    assert.match(result.stdout, /MARKER_VERIFIED/);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    assert.equal(readFileSync(join(f.state, "start-count"), "utf8"), "1");
    assert.equal(readFileSync(join(f.state, "running"), "utf8"), f.sha);
    assert.deepEqual(JSON.parse(readFileSync(f.startSnapshot)), before);
    assert.deepEqual(JSON.parse(readFileSync(f.finishSnapshot)), before);
    const finishArgs = JSON.parse(readFileSync(f.finishArguments));
    assert.equal(finishArgs.at(-1), "restored");
    assert.equal(existsSync(f.journal), false);
    assert.deepEqual(fileSnapshot(f.protectedFiles.slice(1)), before.slice(1));
    assertFullVerification(f); assertNoOtherMutation(f);
  });
}

test("stopped selected candidate refuses with stopped units and an empty system cgroup", (t) => {
  const f = restoredFixture(t, { groups: "empty" });
  for (const [name, target] of [["current", join(f.serving, "releases", candidateSha)], ["previous", f.initial]]) {
    rmSync(join(f.serving, name)); symlinkSync(target, join(f.serving, name));
  }
  const before = fileSnapshot(f.protectedFiles);
  assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
});

for (const [name, change] of [
  ["active legacy owner", { user: "active", "user-pid": 555 }],
  ["enabled legacy owner", { "user-enabled": "enabled" }],
  ["disabled system owner", { "system-enabled": "disabled" }],
  ["system main PID", { pid: 555 }],
  ["system control process", { "system-control-pid": 555 }],
  ["system job", { "system-job": 19 }],
  ["legacy main PID", { "user-pid": 555 }],
  ["legacy control process", { "user-control-pid": 555 }],
  ["legacy job", { "user-job": 19 }],
  ["existing listener", { "listener-pid": 555 }],
  ["missing last system process", { "system-exec-main-pid": 0 }],
  ["missing last system start", { "system-exec-start-monotonic": 0 }],
  ["malformed invocation", { "system-invocation-id": "unknown" }],
  ["empty system invocation", { "system-invocation-id": "" }],
  ["foreign system slice", { "system-slice": "custom.slice" }],
  ["foreign system cgroup", { "system-control-group": "/system.slice/another.service" }],
  ["legacy start timestamp without a PID", { "user-exec-start-monotonic": 5550000 }],
  ["legacy invocation without a PID", { "user-invocation-id": "5".repeat(32) }],
  ["legacy cgroup without a PID", { "user-control-group": "/user.slice/another.service" }],
  ["prior legacy execution history", { "user-exec-main-pid": 555, "user-exec-start-monotonic": 5550000 }],
]) test(`${name} refuses recovery before starting`, (t) => {
  const f = restoredFixture(t); setState(f, change);
  const before = fileSnapshot(f.protectedFiles);
  assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
});

for (const [name, pid] of [["journal predecessor", 111], ["last system execution", 222], ["last legacy execution", 555]]) {
  test(`a retained or reused ${name} process path refuses recovery`, (t) => {
    const f = restoredFixture(t);
    if (pid === 555) setState(f, { "user-exec-main-pid": pid, "user-exec-start-monotonic": 5550000 });
    processEntry(f, pid, 9999);
    const before = fileSnapshot(f.protectedFiles);
    assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
    assert.ok(existsSync(join(f.root, "proc", String(pid))));
  });
}

test("system cgroup descendants prevent start even when the unit reports no ControlGroup", (t) => {
  const f = restoredFixture(t, { groups: "empty" });
  setState(f, { "system-control-group": "" });
  writeFileSync(join(f.cgroup(f.systemGroup), "cgroup.events"), "populated 1\nfrozen 0\n");
  const before = fileSnapshot(f.protectedFiles);
  assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
});

for (const [name, groups, target] of [
  ["writable sys ancestor with absent leaf", "absent", (f) => join(f.root, "sys")],
  ["writable cgroup root with absent leaf", "absent", (f) => f.cgroup("")],
  ["writable slice with absent leaf", "absent", (f) => f.cgroup("system.slice")],
  ["writable unit cgroup", "empty", (f) => f.cgroup(f.systemGroup)],
]) test(`${name} refuses recovery before start`, (t) => {
  const f = restoredFixture(t, { groups }), directory = target(f);
  chmodSync(directory, 0o775);
  const before = fileSnapshot(f.protectedFiles), unsafe = fileSnapshot([directory]);
  assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
  assert.deepEqual(fileSnapshot([directory]), unsafe);
});

for (const [name, group, groups] of [
  ["root", "", "absent"], ["slice", "system.slice", "absent"],
  ["unit", "system.slice/openclaw-gateway.service", "empty"],
]) {
  for (const control of ["cgroup.procs", "cgroup.threads", "cgroup.subtree_control"]) {
    test(`writable ${name} ${control} refuses recovery before start`, (t) => {
      const f = restoredFixture(t, { groups }), file = join(f.cgroup(group), control);
      chmodSync(file, 0o664);
      const before = fileSnapshot(f.protectedFiles), unsafe = fileSnapshot([file]);
      assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
      assert.deepEqual(fileSnapshot([file]), unsafe);
    });
  }
}

for (const [name, change] of [
  ["missing parent membership control", (f) => rmSync(join(f.cgroup("system.slice"), "cgroup.procs"))],
  ["symlink membership control", (f) => {
    const file = join(f.cgroup(f.systemGroup), "cgroup.threads");
    rmSync(file); symlinkSync(join(f.cgroup(f.systemGroup), "cgroup.procs"), file);
  }],
  ["writable populated evidence", (f) => chmodSync(join(f.cgroup(f.systemGroup), "cgroup.events"), 0o664)],
  ["retained leaf subgroup", (f) => mkdirSync(join(f.cgroup(f.systemGroup), "delegated-child"))],
  ["symlink leaf entry", (f) => symlinkSync(f.cgroup("system.slice"), join(f.cgroup(f.systemGroup), "delegated-alias"))],
]) test(`${name} refuses even when populated is zero`, (t) => {
  const f = restoredFixture(t, { groups: "empty" }); change(f);
  const before = fileSnapshot(f.protectedFiles);
  assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
});

for (const [name, uid, gid] of [
  ["foreign membership owner", 1000, 0], ["foreign membership group", 0, 1000],
]) test(`${name} refuses recovery before start`, {
  skip: process.getuid() !== 0 ? "real ownership substitution requires isolated root fixture execution" : false,
}, (t) => {
  const f = restoredFixture(t, { groups: "empty" }), file = join(f.cgroup(f.systemGroup), "cgroup.procs");
  chownSync(file, uid, gid);
  const before = fileSnapshot(f.protectedFiles), unsafe = fileSnapshot([file]);
  assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
  assert.deepEqual(fileSnapshot([file]), unsafe);
});

for (const [name, change] of [
  ["missing permit", (f) => rmSync(f.permit)],
  ["changed permit", (f) => writeFileSync(f.permit, "foreign permit\n")],
  ["missing condition", (f) => rmSync(f.guard)],
  ["changed condition", (f) => writeFileSync(f.guard, "[Unit]\nConditionPathExists=/unrelated\n")],
  ["unloaded condition", (f) => setState(f, { "guard-loaded": 0 })],
  ["changed original previous", (f) => {
    rmSync(join(f.serving, "previous")); symlinkSync(f.initial, join(f.serving, "previous"));
  }],
  ["third current release", (f) => {
    rmSync(join(f.serving, "current")); symlinkSync(join(f.serving, "releases", previousSha), join(f.serving, "current"));
  }],
  ["replaced protected config", (f) => {
    const replacement = `${f.configPath}.replacement`;
    writeFileSync(replacement, readFileSync(f.configPath), { mode: 0o600 }); renameSync(replacement, f.configPath);
  }],
  ["replaced original witness", (f) => writeFileSync(f.originalWitness, "[]")],
  ["unsupported shared schema", (f) => {
    const db = new DatabaseSync(f.databasePath); db.exec("PRAGMA user_version=2"); db.close();
  }],
  ["unsupported agent schema", (f) => {
    const db = new DatabaseSync(f.agentDatabasePath); db.exec("PRAGMA user_version=2; UPDATE schema_meta SET schema_version=2"); db.close();
  }],
]) test(`${name} retains recovery evidence before start`, (t) => {
  const f = restoredFixture(t); change(f);
  const before = fileSnapshot(f.protectedFiles);
  assertRefusedBeforeStart(f, runOwner(f, ["--recover"]), before);
});

test("force is not a recovery authority", (t) => {
  const f = restoredFixture(t), before = fileSnapshot(f.protectedFiles);
  assertRefusedBeforeStart(f, runOwner(f, ["--recover", "--force"]), before);
});

for (const scenario of ["recovery-start-refused", "start-skip0"]) {
  test(`${scenario} preserves the journal and never rolls back or claims verification`, (t) => {
    const f = restoredFixture(t, { scenario }), before = fileSnapshot(f.protectedFiles);
    const result = runOwner(f, ["--recover"]);
    assert.ifError(result.error); assert.notEqual(result.status, 0, result.stdout);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    assert.doesNotMatch(events(f), /gateway gateway call agent\n|proof\.recovery-finish/);
    assert.doesNotMatch(result.stdout, /RECOVERED|MARKER_VERIFIED/);
    assert.doesNotMatch(result.stderr, /ROLLED_BACK/);
    assert.deepEqual(fileSnapshot(f.protectedFiles), before);
    assert.deepEqual(JSON.parse(readFileSync(f.startSnapshot)), before);
    assertNoOtherMutation(f);
  });
}

test("failed full verification retains the journal, and a live retry verifies without a second start", (t) => {
  const f = restoredFixture(t, { scenario: "marker-wrong-session" }), before = fileSnapshot(f.protectedFiles);
  const failed = runOwner(f, ["--recover"]);
  assert.ifError(failed.error); assert.notEqual(failed.status, 0, failed.stdout);
  assert.doesNotMatch(failed.stdout, /RECOVERED|MARKER_VERIFIED/);
  assert.doesNotMatch(failed.stderr, /ROLLED_BACK/);
  assert.deepEqual(fileSnapshot(f.protectedFiles), before);
  assert.equal(events(f).split("service.system.start\n").length - 1, 1);
  assert.match(events(f), /gateway gateway call agent.wait/);
  const pid = readFileSync(join(f.state, "pid"), "utf8");
  const generation = readFileSync(join(f.root, "proc", pid, "stat"));
  setState(f, { scenario: "success", events: "" });
  const recovered = runOwner(f, ["--recover"]);
  assert.ifError(recovered.error); assert.equal(recovered.status, 0, recovered.stderr + events(f));
  assert.doesNotMatch(events(f), /service\.system\.start/);
  assert.equal(readFileSync(join(f.state, "start-count"), "utf8"), "1");
  assert.equal(readFileSync(join(f.state, "pid"), "utf8"), pid);
  assert.deepEqual(readFileSync(join(f.root, "proc", pid, "stat")), generation);
  assert.deepEqual(JSON.parse(readFileSync(f.finishSnapshot)), before);
  assert.equal(existsSync(f.journal), false);
  assert.deepEqual(fileSnapshot(f.protectedFiles.slice(1)), before.slice(1));
  assertFullVerification(f); assertNoOtherMutation(f);
});

test("a replacement generation before the marker is refused without sending to the replacement", (t) => {
  const f = restoredFixture(t, { scenario: "recovery-generation-before-marker" }), before = fileSnapshot(f.protectedFiles);
  const result = runOwner(f, ["--recover"]);
  assert.ifError(result.error); assert.notEqual(result.status, 0, result.stdout);
  assert.match(events(f), /process.replaced-before-marker/);
  assert.equal(events(f).split("service.system.start\n").length - 1, 1);
  assert.doesNotMatch(events(f), /gateway gateway call agent\n|proof\.recovery-finish/);
  assert.doesNotMatch(result.stdout, /RECOVERED|MARKER_VERIFIED/);
  assert.doesNotMatch(result.stderr, /ROLLED_BACK/);
  assert.deepEqual(fileSnapshot(f.protectedFiles), before);
  assert.equal(readFileSync(join(f.state, "pid"), "utf8"), "444");
  assertNoOtherMutation(f);
});
