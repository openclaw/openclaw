import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { events, makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";

const candidate = "b".repeat(40);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const ok = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };

function fixture(t) {
  const f = makeReleaseFixture(t);
  f.library = join(f.root, "release-lib.mjs");
  writeFileSync(f.library, readFileSync(join(import.meta.dirname, "release-lib.mjs"), "utf8").replace(
    'const suspensionContractPath = "/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs";',
    `const suspensionContractPath = ${JSON.stringify(join(import.meta.dirname, "gateway-suspension-contract.mjs"))};`));
  f.env.OPENCLAW_TEAM_RELEASE_LIB = f.library;
  f.proof = (args, input) => spawnSync(process.execPath, ["--no-warnings", f.library, ...args], { encoding: "utf8", env: f.env, input, timeout: 20_000 });
  const releases = [];
  for (const [release, sha, state] of [[f.initial, f.sha, 19], [f.addRelease(candidate), candidate, 20]]) {
    chmodSync(release, 0o755);
    const file = join(release, "package.json"), value = JSON.parse(readFileSync(file));
    value.openclaw.schemaVersions = { state, agent: 24 };
    chmodSync(file, 0o644); writeFileSync(file, JSON.stringify(value));
    ok(f.proof(["manifest", release, sha, String(process.getuid()), sha]));
    ok(f.proof(["seal-tree", release]));
    releases.push(JSON.parse(ok(f.proof(["validate-release", release, sha, String(process.getuid()), "sealed"]))));
  }
  const record = {
    version: 1, topology: "system", offlineDoctor: true, predecessor: releases[0], candidate: releases[1],
    process: { pid: 111, generation: "1110", instance: "fixture-instance-111" },
    services: { system: { unitFileState: "enabled", activeState: "active" }, user: { unitFileState: "disabled", activeState: "inactive" } },
    suspension: null,
    protectedPaths: JSON.parse(ok(f.proof(["fingerprint", f.configPath, f.databasePath]))),
    pointerTopology: { current: { present: true, sha: f.sha }, previous: { present: false, sha: null } },
  };
  f.evidence = JSON.parse(ok(f.proof(["migration-create", f.serving, "@stdin"], JSON.stringify(record))));
  f.stage = f.evidence.identity.stage.path;
  f.retained = join(f.serving, "journal", `abandoned-${f.evidence.record.agentMigration.stage}`);
  f.receiptName = `abandon-${f.evidence.record.agentMigration.stage}.json`;
  f.attempt = join(f.stage, "rehearsal-76a4a87b-1234-4123-8123-123456789abc");
  mkdirSync(f.attempt, { mode: 0o700 });
  for (const name of ["rootfs", "serving", "snapshots"]) mkdirSync(join(f.attempt, name), { mode: 0o700 });
  writeFileSync(join(f.attempt, "rootfs", "retained-copy"), "synthetic rehearsal bytes");
  for (const name of ["copy-manifest.json", "doctor.stdout", "doctor.stderr", "verify.stdout", "verify.stderr"])
    writeFileSync(join(f.attempt, name), "{}\n", { mode: 0o600 });
  for (const [label, status] of [["doctor", 0], ["verify", 2]])
    writeFileSync(join(f.attempt, `${label}.outcome.json`), JSON.stringify({ version: 1, phase: label, timeoutMs: 600_000, elapsedMs: 50, status, signal: null, errorCode: null }), { mode: 0o600 });
  writeFileSync(join(f.state, "timer-active"), "inactive");
  const driver = join(f.commands, "service-fixture.cjs");
  writeFileSync(driver, readFileSync(driver, "utf8")
    .replace('UnitFileState:"enabled",TimersCalendar:', 'UnitFileState:present("timer-enabled")?read("timer-enabled"):"disabled",TimersCalendar:')
    .replace('Job:present("updater-job")?read("updater-job"):"0",', 'Job:!timer&&present("updater-job")?read("updater-job"):"0",')
    .replace('InvocationID:read(scope+"-invocation-id"),', 'NRestarts:present("nrestarts")?read("nrestarts"):"0",InvocationID:read(scope+"-invocation-id"),'));
  writeFileSync(join(f.root, "proc/111/cmdline"), "node\0gateway\0");
  writeFileSync(join(f.root, "proc/111/environ"), `INVOCATION_ID=${"1".repeat(32)}\0`);
  // Use a real kernel flock on macOS too, where the shared fixture otherwise uses a no-op shim.
  if (!f.realCommands.flock) {
    const python = ok(spawnSync("/usr/bin/which", ["python3"], { encoding: "utf8" }));
    writeFileSync(f.commandPaths.flock, `#!/bin/sh\nexec ${quote(python)} -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)'\n`, { mode: 0o755 });
  }
  f.run = (args = ["--recover", "--abandon-rehearsal", candidate]) => {
    const result = runOwner(f, args);
    // Synthetic proc fixtures do not model OS process reap; remove only exited fixture owners.
    for (const name of readdirSync(join(f.root, "proc"))) if (name !== "111" && /^\d+$/.test(name)) rmSync(join(f.root, "proc", name), { recursive: true });
    return result;
  };
  return f;
}

function unchanged(f, invoke, pattern) {
  const journal = readFileSync(f.journal), names = readdirSync(f.stage).sort();
  const permit = existsSync(f.permit) ? readFileSync(f.permit) : null;
  const result = invoke();
  assert.ifError(result.error); assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
  assert.deepEqual(readFileSync(f.journal), journal);
  assert.deepEqual(readdirSync(f.stage).sort(), names);
  assert.equal(existsSync(f.retained), false);
  assert.deepEqual(existsSync(f.permit) ? readFileSync(f.permit) : null, permit);
  assert.doesNotMatch(events(f), /service\..*\.(?:start|stop|restart)|suspension\.(?:prepare|handoff|resume)|timer\.start/);
}

test("abandon rehearsal retains exact journal, copied evidence and outcome receipt, releases lock and permits ordinary no-journal admission", t => {
  const f = fixture(t), journal = readFileSync(f.journal), stageIdentity = lstatSync(f.stage);
  const permit = readFileSync(f.permit), guard = readFileSync(f.guard);
  assert.match(ok(f.run()), /ABANDONED.*restart=0/);
  assert.equal(existsSync(f.journal), false); assert.equal(existsSync(f.stage), false);
  assert.equal(lstatSync(f.retained).ino, stageIdentity.ino);
  assert.deepEqual(readFileSync(join(f.retained, "activation.abandoned.json")), journal);
  const receipt = JSON.parse(readFileSync(join(f.retained, f.receiptName)));
  assert.deepEqual(receipt.intent.journal, f.evidence.identity);
  assert.equal(receipt.intent.snapshot.attempts[0].outcomes.verify.summary.status, 2);
  assert.equal(receipt.intent.snapshot.attempts[0].outcomes.doctor.summary.status, 0);
  assert.equal(receipt.operator.uid, process.getuid()); assert.ok(receipt.preparedAt > 0);
  assert.equal(readFileSync(join(f.retained, f.attempt.split("/").at(-1), "rootfs/retained-copy"), "utf8"), "synthetic rehearsal bytes");
  assert.deepEqual(readFileSync(f.permit), permit); assert.deepEqual(readFileSync(f.guard), guard);
  assert.equal(ok(f.proof(["migration-status", f.journal, f.serving])), "none");
  // Reacquire through the real owner, reach its normal no-journal return, and leave evidence untouched.
  assert.equal(f.run(["--recover"]).status, 0);
  const refused = f.run(); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /no activation journal pending/);
  assert.doesNotMatch(events(f), /service\..*\.(?:start|stop|restart)|suspension\.(?:prepare|handoff|resume)|timer\.start/);
});

for (const [name, change, pattern] of [
  ["artifacts present", f => { const r = JSON.parse(readFileSync(f.journal)); r.agentMigration.artifacts.preflight = {}; writeFileSync(f.journal, JSON.stringify(r)); }, /refuses migration artifacts/],
  ...["prepared", "doctor-started", "stores-verified", "recovering-predecessor"].map(phase => [phase, f => { const r = JSON.parse(readFileSync(f.journal)); r.phase = phase === "prepared" ? "A_PREPARED" : "C_CURRENT_SELECTED"; r.agentMigration.phase = phase; writeFileSync(f.journal, JSON.stringify(r)); }, /requires AGENT_REHEARSAL/]),
  ["predecessor pointer mismatch", f => { unlinkSync(join(f.serving, "current")); symlinkSync(join(f.serving, "releases", candidate), join(f.serving, "current")); }, /current pointer identity changed/],
  ["Gateway start ticks changed", f => writeFileSync(join(f.root, "proc/111/stat"), readFileSync(join(f.root, "proc/111/stat"), "utf8").replace("1110", "2220")), /original running predecessor/],
  ["Gateway invocation changed", f => writeFileSync(join(f.state, "system-invocation-id"), "2".repeat(32)), /Gateway invocation changed/],
  ["Gateway restarted", f => writeFileSync(join(f.state, "nrestarts"), "1"), /Gateway generation, restart count or job changed/],
  ["Gateway process instance changed", f => { const r = JSON.parse(readFileSync(f.journal)); r.process.instance = "other-instance"; writeFileSync(f.journal, JSON.stringify(r)); }, /Gateway process instance changed/],
  ["suspension recorded", f => { const r = JSON.parse(readFileSync(f.journal)); r.suspension = { id: "unexpected" }; writeFileSync(f.journal, JSON.stringify(r)); }, /no suspension/],
  ["missing permit", f => unlinkSync(f.permit), /original positive start permit/],
  ["extra permit", f => writeFileSync(f.permit + ".extra", "{}", { mode: 0o600 }), /permit, guard or publication side effect/],
  ["stage guard", f => writeFileSync(join(f.root, "etc/systemd/system/openclaw-gateway.service.d/stage.conf"), `# ${f.evidence.record.agentMigration.stage}\n`, { mode: 0o644 }), /stage-bound guard/],
  ["cold backups", f => mkdirSync(join(f.stage, "backups"), { mode: 0o700 }), /non-rehearsal stage artifact/],
  ["cold witness", f => writeFileSync(join(f.stage, "witness-unknown.json"), "{}", { mode: 0o600 }), /non-rehearsal stage artifact/],
  ["precapture", f => writeFileSync(join(f.stage, "precapture-unknown.json"), "{}", { mode: 0o600 }), /non-rehearsal stage artifact/],
  ["timer enabled", f => writeFileSync(join(f.state, "timer-enabled"), "enabled"), /hourly timer disabled and inactive/],
  ["timer active", f => writeFileSync(join(f.state, "timer-active"), "active"), /hourly timer disabled and inactive/],
  ["updater job", f => writeFileSync(join(f.state, "updater-job"), "77"), /settled updater/],
  ["another canonical executable", f => { mkdirSync(join(f.root, "proc/888")); writeFileSync(join(f.root, "proc/888/cmdline"), "bash\0/usr/local/sbin/openclaw-release-deploy\0"); }, /another canonical executable/],
]) test(`abandon rehearsal refuses ${name} without mutation`, t => {
  const f = fixture(t); change(f); unchanged(f, () => f.run(), pattern);
});

for (const [name, args, pattern] of [
  ["candidate mismatch", ["--recover", "--abandon-rehearsal", "c".repeat(40)], /candidate SHA mismatch/],
  ["combined cleanup", ["--recover", "--abandon-rehearsal", candidate, "--cleanup"], /cannot be combined/],
  ["combined selector", ["--recover", "--abandon-rehearsal", candidate, "--sha", candidate], /without another action/],
  ["combined recovery", ["--recover", "--abandon-rehearsal", candidate, "--allow-cpu-degraded"], /without another action/],
  ["missing recover", ["--abandon-rehearsal", candidate], /requires --recover/],
  ["empty candidate", ["--recover", "--abandon-rehearsal", ""], /candidate SHA/],
]) test(`abandon rehearsal refuses ${name} before effects`, t => {
  const f = fixture(t); unchanged(f, () => f.run(args), pattern);
});

test("abandon rehearsal with nothing pending refuses", t => {
  const f = fixture(t); unlinkSync(f.journal);
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /no activation journal pending/);
  assert.equal(existsSync(join(f.stage, f.receiptName)), false);
});

for (const boundary of ["receipt", "journal-rename"]) test(`abandon rehearsal crash after ${boundary} retains evidence and cannot resume old candidate`, t => {
  const f = fixture(t), source = readFileSync(f.library, "utf8"), journal = readFileSync(f.journal);
  const anchor = boundary === "receipt" ? "  renameSync(pathname, retiredJournal);" : "  renameSync(stage, destination);";
  writeFileSync(f.library, source.replace(anchor, '  process.exit(99);\n' + anchor));
  assert.notEqual(f.run().status, 0);
  assert.ok(existsSync(join(f.stage, f.receiptName)));
  assert.deepEqual(readFileSync(boundary === "receipt" ? f.journal : join(f.stage, "activation.abandoned.json")), journal);
  writeFileSync(f.library, source);
  if (boundary === "receipt") {
    assert.match(f.proof(["migration-status", f.journal, f.serving]).stderr, /abandonment intent is retained/);
    assert.match(ok(f.run()), /ABANDONED/);
  } else {
    assert.equal(ok(f.proof(["migration-status", f.journal, f.serving])), "none");
    const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /no activation journal pending/);
  }
});
