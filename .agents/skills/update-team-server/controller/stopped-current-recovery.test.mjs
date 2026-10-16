import assert from "node:assert/strict";
import { chmodSync, chownSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { events, makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";

const boot = "bb487067-6290-49f7-bba7-7fd6970bc53e";
const invocation = "2".repeat(32);
const state = (f, values) => {
  for (const [name, value] of Object.entries(values)) writeFileSync(join(f.state, name), String(value));
};
function fixture(t, scenario = "success", timer = "inactive") {
  const f = makeReleaseFixture(t, scenario);
  writeFileSync(f.lockFile, "", { mode: 0o644, flag: "wx" });
  const environmentFiles = ["first", "second", "third"].map(name => {
    const file = join(f.state, name + ".env");
    writeFileSync(file, "SYNTHETIC_" + name.toUpperCase() + "=1\n", { mode: 0o600 });
    return file;
  });
  state(f, { "environment-files": JSON.stringify(environmentFiles) });
  state(f, { system: "failed", pid: 0, "listener-pid": 0, "system-exec-main-pid": 222,
    "system-exec-start-monotonic": 2220000, "system-invocation-id": invocation, "timer-active": timer });
  rmSync(join(f.root, "proc", String(f.pid)), { recursive: true });
  mkdirSync(join(f.root, "proc/sys/kernel/random"), { recursive: true });
  writeFileSync(join(f.root, "proc/sys/kernel/random/boot_id"), boot + "\n");
  mkdirSync(join(f.serving, "verified"), { mode: 0o700 });
  writeFileSync(join(f.serving, "verified", f.sha), f.sha + "\n", { mode: 0o600 });
  for (const name of ["openclaw-hourly-update.timer", "openclaw-hourly-update.service"])
    writeFileSync(join(f.root, "etc/systemd/system", name), "# synthetic scheduler input\n", { mode: 0o644 });
  f.args = ["--recover", "--start-stopped-current", f.sha, boot, "222", "2220000", invocation];
  f.receipt = join(f.serving, "journal", `operator-start-current-${boot}-${invocation}.log`);
  return f;
}
function noLifecycle(f) {
  assert.doesNotMatch(events(f), /service\.(?:system|user)\.(?:start|stop|restart|enable|disable|daemon-reload)\n|timer.start/);
}
function noOtherMutation(f) {
  assert.doesNotMatch(events(f), /service\.(?:system|user)\.(?:stop|restart|enable|disable|daemon-reload)\n|service.user.start|gateway config set|account.openclaw-deploy/);
  assert.equal(readdirSync(join(f.serving, "journal")).includes("activation.json"), false);
}
for (const timer of ["inactive", "active"]) test(`same-current stopped recovery starts once and preserves the ${timer} timer policy`, (t) => {
  const f = fixture(t, "success", timer);
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + events(f));
  assert.match(result.stdout, /RECOVERED .*action=verified-current-after-start-request native-start-attribution=unproven APPROVAL_DELTA=0/);
  assert.equal(events(f).split("service.system.start\n").length - 1, 1);
  assert.equal(events(f).split("timer.start\n").length - 1, timer === "inactive" ? 1 : 0);
  const receipt = readFileSync(f.receipt, "utf8");
  assert.match(receipt, /phase=start-intent/); assert.match(receipt, /phase=gateway-verified/); assert.match(receipt, /phase=recovered/);
  assert(receipt.indexOf("phase=gateway-verified") < receipt.lastIndexOf('"timer":'));
  assert(receipt.lastIndexOf('"timer":') < receipt.indexOf("phase=recovered"));
  assert.match(events(f), /gateway gateway call agent.wait/);
  noOtherMutation(f);
});

function catchupFixture(t, scenario) {
  const f = fixture(t, scenario), environment = join(f.root, "timer-catchup.sh");
  writeFileSync(environment, `sleep() { SECONDS=$((SECONDS + ${scenario === "timer-catchup-timeout" ? 600 : 1})); }\n`);
  f.env.BASH_ENV = environment;
  return f;
}

test("restored persistent timer waits for its catch-up updater before acceptance", (t) => {
  const f = catchupFixture(t, "timer-catchup-delayed"), result = runOwner(f, f.args);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + events(f));
  const log = events(f);
  assert(log.indexOf("timer.start") < log.indexOf("timer.catchup-poll.1"));
  assert(log.indexOf("timer.catchup-poll.2") < log.indexOf("timer.catchup-settled"));
  assert.equal(log.split("timer.start\n").length - 1, 1);
  assert.match(result.stdout, /RECOVERED/);
  assert.match(readFileSync(f.receipt, "utf8"), /phase=recovered/);
  noOtherMutation(f);
});

for (const [scenario, reason] of [
  ["timer-catchup-timeout", /did not settle within verification budget/],
  ["timer-catchup-query-failed", /synthetic catch-up status failure/],
  ["timer-catchup-external-stop", undefined],
]) test(`${scenario} keeps restored timer recovery unaccepted`, (t) => {
  const f = catchupFixture(t, scenario), result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0);
  if (reason) assert.match(result.stderr, reason);
  assert.doesNotMatch(result.stdout, /RECOVERED/);
  assert.equal(events(f).split("timer.start\n").length - 1, 1);
  if (scenario === "timer-catchup-query-failed") assert.doesNotMatch(events(f), /timer.catchup-poll.2/);
  assert.match(readFileSync(f.receipt, "utf8"), /phase=timer-partial/);
  noOtherMutation(f);
});

for (const [name, change, reason] of [
  ["stale boot", (f) => { f.args[3] = "a".repeat(8) + "-6290-49f7-bba7-7fd6970bc53e"; }],
  ["stale last PID", (f) => { f.args[4] = "223"; }],
  ["stale last start", (f) => { f.args[5] = "2220001"; }],
  ["stale invocation", (f) => { f.args[6] = "3".repeat(32); }],
  ["live system owner", (f) => state(f, { system: "active", pid: 111 })],
  ["pending Gateway job", (f) => state(f, { "system-job": 123 })],
  ["pending updater job", (f) => state(f, { "updater-job": 123 })],
  ["duplicate scalar unit property", (f) => state(f, { scenario: "duplicate-scalar-property" })],
  ["invalid current config", (f) => {
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    config.cloudWorkers.profiles.aws.settings.setup = 17;
    writeFileSync(f.configPath, JSON.stringify(config));
  }],
  ["config include directive", (f) => {
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    config.gateway = { $include: "gateway-fragment.json" };
    writeFileSync(f.configPath, JSON.stringify(config));
  }, /requires a self-contained config/],
  ["writable environment file ancestor", (f) => {
    const directory = join(f.root, "unit-environment");
    mkdirSync(directory); const file = join(directory, "runtime.env");
    writeFileSync(file, "SYNTHETIC_INPUT=1\n", { mode: 0o600 });
    chmodSync(directory, 0o777); state(f, { "environment-files": JSON.stringify([file]) });
  }, /environment file ancestor is unsafe/],
  ["remaining listener", (f) => state(f, { "listener-pid": 111 })],
  ["world-writable agent database", (f) => chmodSync(f.agentDatabasePath, 0o666), /state file ownership/],
  ["group-writable shared database", (f) => chmodSync(f.databasePath, 0o660), /state file ownership/],
  ["writable data ancestor", (f) => chmodSync(dirname(f.agentDatabasePath), 0o777), /state ancestor ownership/],
  ["multiply linked database", (f) => linkSync(f.agentDatabasePath, join(f.state, "database-link")), /state file ownership/],
  ["dangling WAL link", (f) => symlinkSync(join(f.state, "missing-wal"), f.agentDatabasePath + "-wal"), /state file ownership/],
  ["missing native guard", (f) => rmSync(f.guard)],
  ["missing native permit", (f) => rmSync(f.permit)],
  ["missing verified marker", (f) => rmSync(join(f.serving, "verified", f.sha))],
  ["spent incident", (f) => writeFileSync(f.receipt, "retained earlier intent\n", { mode: 0o600 })],
  ["activation journal", (f) => writeFileSync(f.journal, "{}\n", { mode: 0o600 })],
  ["unfinished profiling publication", (f) => mkdirSync(join(f.root, "var/lib/openclaw-team-diagnostics/.pending-" + boot), { recursive: true })],
  ["competing pre-lock owner", (f) => { mkdirSync(join(f.root, "proc/919")); writeFileSync(join(f.root, "proc/919/cmdline"), "bash\0/usr/local/sbin/openclaw-release-deploy\0"); }],
  ["remaining agent-store writer", (f) => {
    const process = join(f.root, "proc/919");
    mkdirSync(join(process, "fd"), { recursive: true }); mkdirSync(join(process, "fdinfo"));
    writeFileSync(join(process, "cmdline"), "node\0unrelated-maintenance.mjs\0");
    writeFileSync(join(process, "maps"), ""); symlinkSync(f.agentDatabasePath, join(process, "fd/3"));
    writeFileSync(join(process, "fdinfo/3"), "flags:\t0100002\n");
  }],
]) test(`${name} refuses without Gateway or timer lifecycle actions`, (t) => {
  const f = fixture(t); change(f);
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0, result.stdout);
  if (reason) assert.match(result.stderr, reason);
  assert.doesNotMatch(result.stdout, /RECOVERED|MARKER_VERIFIED/); noLifecycle(f);
});

test("foreign-owned database refuses before any lifecycle action", {
  skip: process.getuid() !== 0 ? "real foreign UID proof requires isolated root" : false,
}, (t) => {
  const f = fixture(t); chownSync(f.agentDatabasePath, 1111, 1111);
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /state file ownership/); noLifecycle(f);
});

for (const scenario of ["recovery-start-refused", "start-skip0", "start-uncertain", "start-pending-job", "marker-wrong-session", "timer-start-failed", "generation-changed-during-timer", "raced-stop-job"]) {
  test(`${scenario} remains unaccepted and cannot issue another start for the incident`, (t) => {
    const f = fixture(t, scenario), result = runOwner(f, f.args);
    assert.ifError(result.error); assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /RECOVERED/);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1, result.stderr);
    if (["start-pending-job", "raced-stop-job"].includes(scenario)) assert.doesNotMatch(events(f), /timer.start/);
    assert.doesNotMatch(events(f), /competing-stop.replaced/);
    const receipt = readFileSync(f.receipt, "utf8"); assert.match(receipt, /phase=start-intent/);
    const retried = runOwner(f, f.args);
    assert.ifError(retried.error); assert.notEqual(retried.status, 0);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    noOtherMutation(f);
  });
}

test("an externally stopped previously active timer is not restarted", (t) => {
  const f = fixture(t, "timer-stopped-after-marker", "active");
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0);
  assert.match(events(f), /gateway gateway call agent.wait/);
  assert.doesNotMatch(events(f), /timer.start/);
  assert.equal(readFileSync(join(f.state, "timer-active"), "utf8"), "inactive");
  assert.doesNotMatch(result.stdout, /RECOVERED/);
});

test("an active timer with changed trigger and deadline cannot be silently accepted", (t) => {
  const f = fixture(t, "timer-fired-after-marker", "active");
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0);
  assert.match(events(f), /timer.externally-fired/);
  assert.doesNotMatch(events(f), /timer.start/);
  assert.doesNotMatch(result.stdout, /RECOVERED/);
  assert.match(readFileSync(f.receipt, "utf8"), /phase=timer-partial/);
});

test("timer movement during pre-start validation refuses the Gateway request", (t) => {
  const f = fixture(t, "timer-change-during-validation", "active");
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0);
  assert.match(events(f), /timer.changed-during-validation/);
  noLifecycle(f);
});

test("drift in the first of three native EnvironmentFiles refuses acceptance", (t) => {
  const f = fixture(t, "first-environment-file-drift");
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0);
  assert.match(events(f), /environment.first-file-changed/);
  assert.doesNotMatch(result.stdout, /RECOVERED/);
  assert.equal(events(f).split("service.system.start\n").length - 1, 1);
  assert.doesNotMatch(events(f), /timer.start/);
});

test("a timer stopped after restoration is rejected by the terminal acceptance fence", (t) => {
  const f = fixture(t, "timer-stopped-after-observation");
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0);
  assert.match(events(f), /timer.externally-stopped-after-observation/);
  assert.equal(events(f).split("timer.start\n").length - 1, 1);
  assert.doesNotMatch(result.stdout, /RECOVERED/);
  assert.match(readFileSync(f.receipt, "utf8"), /phase=verification-partial/);
});

test("even an empty captured agent store must preserve its physical identity", (t) => {
  const f = fixture(t, "replace-empty-store-on-start");
  const db = new DatabaseSync(f.agentDatabasePath);
  try { db.exec("DELETE FROM session_nodes"); } finally { db.close(); }
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.notEqual(result.status, 0);
  assert.match(events(f), /empty-store.replaced/);
  assert.doesNotMatch(result.stdout, /RECOVERED/);
  assert.match(readFileSync(f.receipt, "utf8"), /phase=verification-partial/);
});

test("spent profiling artifacts remain unchanged and do not authorize or block a start", (t) => {
  const f = fixture(t), operation = "9f487067-6290-49f7-bba7-7fd6970bc53e";
  const directory = join(f.root, "var/lib/openclaw-team-diagnostics", operation);
  mkdirSync(directory, { recursive: true });
  const record = JSON.stringify({ operation, intent: { mode: "steady", bootId: boot, owner: { pid: 919, start: "9190" } },
    arm: { state: "closed" }, steadyOutcome: { outcome: "incomplete" } });
  writeFileSync(join(directory, "record.json"), record, { mode: 0o600 });
  writeFileSync(join(directory, "steady-revoked.json"), JSON.stringify({ operation }), { mode: 0o600 });
  const result = runOwner(f, f.args);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + events(f));
  assert.equal(readFileSync(join(directory, "record.json"), "utf8"), record);
});
