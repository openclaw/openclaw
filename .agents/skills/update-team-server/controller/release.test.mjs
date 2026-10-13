import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { events, makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";

const owner = dirname(fileURLToPath(import.meta.url));
const before = "a".repeat(40);
const after = "b".repeat(40);
const handoffId = "12345678-1234-4234-8234-123456789abc";

describe("release load acceptance", () => {
  const eventLoop = {
    degraded: true,
    reasons: ["event_loop_delay", "event_loop_utilization", "cpu"],
    intervalMs: 1_057,
    delayP99Ms: 1_057,
    delayMaxMs: 1_057,
    utilization: 1,
    cpuCoreRatio: 1.55,
    degradedSinceMs: 0,
  };
  function snapshots() {
    return {
      health: { ok: true, status: "live" },
      startup: { ok: true, status: "started", uptimeMs: 10_000 },
      readiness: { ready: true, failing: [], uptimeMs: 10_000, eventLoop: { ...eventLoop } },
      channels: {
        eventLoop: { ...eventLoop },
        channelAccounts: Object.fromEntries(
          [["clickclack", "default"], ["discord", "controller-test-agent"], ["reef", "default"]].map(
            ([name, accountId]) => [name, [{ accountId, configured: true, enabled: true,
              running: true, connected: true, lifecycle: "ready", restartPending: false, lastError: null }]],
          ),
        ),
      },
    };
  }
  function check(command, snapshot, allow = true) {
    const args = command === "channels"
      ? ["@stdin"]
      : [JSON.stringify(snapshot.health), "200", JSON.stringify(snapshot.startup), "200",
        JSON.stringify(snapshot.readiness), "200", "@stdin"];
    return spawnSync(process.execPath, [join(owner, "release-lib.mjs"), command, ...args,
      ...(allow ? ["--allow-cpu-degraded"] : [])], {
      input: JSON.stringify(snapshot.channels), encoding: "utf8", timeout: 10_000,
    });
  }

  test("recognized native load reasons warn only with explicit acceptance", () => {
    for (const reasons of [["cpu"], ["event_loop_utilization"], ["event_loop_delay"], eventLoop.reasons]) {
      const snapshot = snapshots();
      snapshot.readiness.eventLoop.reasons = snapshot.channels.eventLoop.reasons = reasons;
      for (const command of ["channels", "probes"]) {
        const strict = check(command, snapshot, false);
        assert.notEqual(strict.status, 0, `${command}: strict load rejection`);
        assert.match(strict.stderr, /snapshot is degraded/);
        const accepted = check(command, snapshot);
        assert.equal(accepted.status, 0, `${command}: ${accepted.stderr}`);
        assert.match(accepted.stdout, /^(CHANNELS|READY)_CPU_DEGRADED_OPERATOR_WAIVED\n$/);
      }
    }
  });

  test("load acceptance retains malformed evidence and channel failure gates", () => {
    for (const mutate of [
      (s) => { s.eventLoop.reasons = ["unknown"]; },
      (s) => { s.eventLoop.reasons = ["cpu", "cpu"]; },
      (s) => { s.eventLoop.reasons = []; },
      (s) => { s.eventLoop.degraded = false; },
      (s) => { delete s.eventLoop.delayP99Ms; },
      (s) => { s.eventLoop.delayMaxMs = -1; },
      (s) => { s.eventLoop.utilization = 1.01; },
      (s) => { s.eventLoop.cpuCoreRatio = null; },
      (s) => { s.eventLoop.intervalMs = 0; },
      (s) => { s.eventLoop.degradedSinceMs = "unknown"; },
      (s) => { s.partial = true; },
      (s) => { s.warnings = ["incomplete"]; },
      (s) => { s.channelAccounts.discord[0].connected = false; },
    ]) {
      const snapshot = snapshots();
      mutate(snapshot.channels);
      for (const command of ["channels", "probes"]) {
        const rejected = check(command, snapshot);
        assert.notEqual(rejected.status, 0, `${command}: invalid evidence accepted`);
        assert.match(rejected.stderr, /malformed|contradictory|not exactly ready/);
      }
    }
  });

  test("load acceptance retains health, startup and readiness failures", () => {
    for (const mutate of [
      (s) => { s.health.ok = false; },
      (s) => { s.startup.status = "starting"; },
      (s) => { s.readiness.ready = false; },
      (s) => { s.readiness.failing = ["discord"]; },
      (s) => { s.readiness.eventLoop.reasons = ["unknown"]; },
    ]) {
      const snapshot = snapshots();
      mutate(snapshot);
      const rejected = check("probes", snapshot);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /healthz|startupz|readyz|degradation reasons/);
    }
  });
});

for (const unit of ["openclaw-disk-maintenance.service", "openclaw-hourly-health-check.service"]) {
  for (const [population, reason] of [
    ["populated 1\nfrozen 0\n", /work has not settled/],
    ["populated unknown\n", /maintenance cgroup state is ambiguous/],
    ["frozen 0\n", /maintenance cgroup population is unknown/],
  ]) {
    test(`release admission refuses unsettled or unknown maintenance ${unit}: ${population.trim()}`, (t) => {
      const fixture = makeReleaseFixture(t);
      const group = join(fixture.root, "sys/fs/cgroup/system.slice", unit);
      mkdirSync(group, { mode: 0o755 });
      writeFileSync(join(group, "cgroup.events"), population);
      writeFileSync(join(group, "cgroup.procs"), "");
      const result = runOwner(fixture, ["--cleanup"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /scheduled maintenance has not settled/);
      assert.match(result.stderr, reason);
      assert.equal(events(fixture), "");
    });
  }
}

function executable(pathname, contents) {
  writeFileSync(pathname, `#!/usr/bin/env bash\nset -euo pipefail\n${contents}\n`, {
    mode: 0o755,
  });
}

function writeProcess(root, pid, startTicks) {
  const directory = join(root, "proc", String(pid));
  mkdirSync(directory, { recursive: true });
  const fields = Array.from({ length: 24 }, () => "0");
  fields[0] = "S";
  fields[19] = String(startTicks);
  writeFileSync(join(directory, "stat"), `${pid} (fixture gateway) ${fields.join(" ")}\n`);
}


const verifiedTarget = "c".repeat(40);

function releaseProof(fixture, ...args) {
  const result = spawnSync(process.execPath, ["--no-warnings", fixture.library, ...args], {
    encoding: "utf8", env: fixture.env, timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function verificationMarker(fixture, sha, modified = Date.now()) {
  const directory = join(fixture.serving, "verified");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = join(directory, sha);
  writeFileSync(marker, sha + "\n", { mode: 0o600 });
  utimesSync(marker, modified / 1000, modified / 1000);
  return marker;
}

function failedReleaseFixture(t, live = false, scenario = "success") {
  const f = makeReleaseFixture(t, scenario);
  if (process.env.TEAM_OWNER_TEST_LIBRARY) {
    f.library = process.env.TEAM_OWNER_TEST_LIBRARY;
    f.env.OPENCLAW_TEAM_RELEASE_LIB = f.library;
  }
  f.addRelease(after);
  f.addRelease(verifiedTarget);
  const predecessor = JSON.parse(releaseProof(f, "validate-release", f.initial, before, String(process.getuid()), "sealed"));
  const candidate = JSON.parse(releaseProof(f, "validate-release", join(f.serving, "releases", after), after, String(process.getuid()), "sealed"));
  const record = {
    version: 1, phase: "ROLLBACK_FAILED", topology: "system", predecessor, candidate,
    process: { pid: 99, generation: "990", instance: "fixture-original-instance" },
    protectedPaths: JSON.parse(releaseProof(f, "fingerprint", f.configPath, f.databasePath)),
    pointerTopology: { current: { present: true, sha: before }, previous: { present: false, sha: null } },
    services: { system: { activeState: "active", unitFileState: "enabled" }, user: { activeState: "inactive", unitFileState: "disabled" } },
    suspension: { id: handoffId, expiresAtMs: Date.now() + 60000, terminalPolicy: "preserve", status: "ready" },
  };
  writeFileSync(f.journal, JSON.stringify(record), { mode: 0o600 });
  rmSync(join(f.serving, "current"));
  symlinkSync(join(f.serving, "releases", after), join(f.serving, "current"));
  symlinkSync(f.initial, join(f.serving, "previous"));
  writeFileSync(join(f.state, "running"), after);
  if (!live) {
    writeFileSync(join(f.state, "system"), "failed");
    writeFileSync(join(f.state, "pid"), "0");
    writeFileSync(join(f.state, "listener-pid"), "0");
  }
  return f;
}

function assertUnchangedRecovery(f, result, reason) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /failed rollback requires explicit recovery of a distinct system release; evidence retained/);
  assert.match(result.stderr, reason);
  assert.equal(readlinkSync(join(f.serving, "current")), join(f.serving, "releases", after));
  assert.equal(readlinkSync(join(f.serving, "previous")), f.initial);
  assert.equal(JSON.parse(readFileSync(f.journal, "utf8")).phase, "ROLLBACK_FAILED");
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|account\.openclaw-deploy/);
}

function deploymentFixture(t) {
  const f = makeReleaseFixture(t);
  if (process.env.TEAM_OWNER_TEST_SOURCE) f.owner = process.env.TEAM_OWNER_TEST_SOURCE;
  if (process.env.TEAM_OWNER_TEST_LIBRARY) f.library = process.env.TEAM_OWNER_TEST_LIBRARY;
  f.addRelease(after);
  // Already-published sealed release; freeze only the synthetic origin, with no network/build.
  executable(join(f.commands, "git"), `
case "$*" in
*'remote get-url origin') printf 'https://github.com/openclaw/openclaw.git\\n' ;;
*'rev-parse refs/remotes/origin/main') printf '${after}\\n' ;;
*'fetch --prune origin'*) ;;
*) exit 64 ;;
esac`);
  const capacityShim = join(f.root, "capacity-shim.mjs");
  writeFileSync(capacityShim, `
import { spawnSync } from 'node:child_process';
if (process.argv[2] !== 'release-capacity') {
const result = spawnSync(process.execPath, [${JSON.stringify(f.library)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
}
`);
  f.env.OPENCLAW_TEAM_RELEASE_LIB = capacityShim;
  return f;
}

function preparedActivationFixture(t, phase, position = "selected", retainPrevious = false) {
  const f = makeReleaseFixture(t);
  if (process.env.TEAM_OWNER_TEST_SOURCE) f.owner = process.env.TEAM_OWNER_TEST_SOURCE;
  if (process.env.TEAM_OWNER_TEST_LIBRARY) {
    f.library = process.env.TEAM_OWNER_TEST_LIBRARY;
    f.env.OPENCLAW_TEAM_RELEASE_LIB = f.library;
  }
  const candidate = f.addRelease(after);
  const previousSha = retainPrevious ? "c".repeat(40) : "absent";
  if (retainPrevious) {
    f.originalPrevious = f.addRelease(previousSha);
    symlinkSync(f.originalPrevious, join(f.serving, "previous"));
  }
  const predecessorInfo = releaseProof(f, "validate-release", f.initial, before, String(process.getuid()), "sealed");
  const candidateInfo = releaseProof(f, "validate-release", candidate, after, String(process.getuid()), "sealed");
  const witness = releaseProof(f, "session-preservation-witness", f.initial, candidate, f.databasePath);
  const creation = spawnSync(process.execPath, ["--no-warnings", f.library, "journal-create", f.journal,
    predecessorInfo, candidateInfo, "system", String(f.pid), f.start, "fixture-instance-111",
    releaseProof(f, "fingerprint", f.configPath, f.databasePath), before, previousSha,
    "enabled", "active", "disabled", "inactive", handoffId, String(Date.now() + 60000), "READY", "@stdin"],
    { env: f.env, encoding: "utf8", input: witness, timeout: 30000 });
  assert.equal(creation.status, 0, creation.stderr);
  const original = releaseProof(f, "journal-read", f.journal);
  if (phase !== "A_PREPARED") {
    rmSync(join(f.serving, "previous"), { force: true });
    symlinkSync(f.initial, join(f.serving, "previous"));
    releaseProof(f, "journal-phase", f.journal, phase, original);
  }
  if (phase === "C_CURRENT_SELECTED" && position === "selected") {
    rmSync(join(f.serving, "current"));
    symlinkSync(candidate, join(f.serving, "current"));
  } else if (position === "restored" && existsSync(join(f.serving, "previous"))) {
    rmSync(join(f.serving, "previous"));
    if (retainPrevious) symlinkSync(f.originalPrevious, join(f.serving, "previous"));
  }
  f.originalJournal = readFileSync(f.journal);
  f.witnessPath = join(f.serving, "journal", JSON.parse(f.originalJournal).originalWitness.name);
  f.originalWitness = readFileSync(f.witnessPath);
  f.candidate = candidate;
  return f;
}

function replacementPredecessor(f, keepOriginal = false) {
  if (!keepOriginal) rmSync(join(f.root, "proc", String(f.pid)), { recursive: true });
  const pid = 222, directory = join(f.root, "proc", String(pid));
  mkdirSync(directory);
  const fields = Array(24).fill("0"); fields[0] = "S"; fields[19] = "2220";
  writeFileSync(join(directory, "stat"), `${pid} (replacement Gateway) ${fields.join(" ")}\n`);
  symlinkSync(f.initial, join(directory, "cwd"));
  symlinkSync("/usr/bin/node", join(directory, "exe"));
  for (const [name, value] of Object.entries({ pid, "listener-pid": pid, "system-exec-main-pid": pid,
    "system-invocation-id": "2".repeat(32), "system-exec-start-monotonic": "2220000" }))
    writeFileSync(join(f.state, name), String(value));
}

function observeCurrentPublication(f, crash = false) {
  executable(join(f.commands, "mv"), `
target="\${@: -1}"
if [[ "$target" == '${join(f.serving, "current")}' ]]; then
  printf 'pointer.current.%s\\n' "$(cat '${join(f.state, "system")}')" >>'${f.eventlog}'
fi
/usr/bin/mv "$@"
if [[ '${crash}' == true && "$target" == '${join(f.serving, "current")}' && ! -e '${join(f.state, "cutover-crashed")}' ]]; then
  : >'${join(f.state, "cutover-crashed")}'
  kill -KILL "$FIXTURE_OWNER_PID"
  exit 137
fi`);
}

describe("Team activation handoff ordering and prepared recovery", () => {
  test("ordinary activation stops the handed-off predecessor before selecting current", t => {
    const f = deploymentFixture(t);
    writeFileSync(join(f.state, "scenario"), "always-draining");
    f.env.OPENCLAW_TEAM_DRAIN_BUDGET = "2";
    observeCurrentPublication(f);
    const result = runOwner(f, ["--interrupt-after-drain"]);
    assert.equal(result.status, 0, result.stderr + events(f));
    const log = events(f);
    assert.ok(log.indexOf("handoff.armed") >= 0 && log.indexOf("handoff.armed") < log.indexOf("service.system.stop"), log);
    assert.ok(log.indexOf("service.system.stop") < log.indexOf("pointer.current.inactive"), log);
    assert.ok(log.indexOf("pointer.current.inactive") < log.indexOf("service.system.start"), log);
    assert.doesNotMatch(log, /pointer\.current\.active|service\.system\.restart/);
    assert.equal(readlinkSync(join(f.serving, "current")), join(f.serving, "releases", after));
    assert.equal(existsSync(f.journal), false);
    assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  });

  for (const [phase, position, retainPrevious] of [["A_PREPARED", "restored"], ["B_PREVIOUS_PUBLISHED", "selected"],
    ["C_CURRENT_SELECTED", "selected"], ["C_CURRENT_SELECTED", "restored"],
    ["C_CURRENT_SELECTED", "selected", true], ["C_CURRENT_SELECTED", "restored", true]]) {
    test(`${phase}/${position}${retainPrevious ? "/retained-previous" : ""} verifies a replacement predecessor without lending the old lease`, t => {
      const f = preparedActivationFixture(t, phase, position, retainPrevious);
      replacementPredecessor(f);
      const result = runOwner(f, ["--recover"]);
      assert.equal(result.status, 0, result.stderr + events(f));
      assert.match(result.stdout, /session-proof=original-pre-cutover/);
      assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
      if (retainPrevious) assert.equal(readlinkSync(join(f.serving, "previous")), f.originalPrevious);
      else assert.equal(existsSync(join(f.serving, "previous")), false);
      assert.equal(existsSync(f.journal), false);
      assert.deepEqual(readFileSync(f.witnessPath), f.originalWitness);
      assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
      assert.equal(existsSync(f.candidate), true);
      assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|gateway\.suspend\.(prepare|resume|handoff)|account\.openclaw-deploy/);
      const queries = events(f).split("\n").filter(line => line.startsWith("suspension.status-query "));
      assert.ok(queries.length > 0);
      assert.ok(queries.every(line => line === `suspension.status-query ${handoffId}`));
      assert.equal(events(f).split("\n").filter(line => line === "gateway gateway call agent").length, 1);
    });
  }

  for (const fault of ["original-process-present", "foreign-suspension", "same-token-suspension", "witness-replaced", "generation-drift"]) {
    test(`replacement predecessor refuses ${fault} and retains original evidence`, t => {
      const f = preparedActivationFixture(t, "C_CURRENT_SELECTED");
      replacementPredecessor(f, fault === "original-process-present");
      if (fault === "foreign-suspension") writeFileSync(join(f.state, "active-lease"), JSON.stringify({ id: "foreign-lease", expiry: Date.now() + 60000 }));
      if (fault === "same-token-suspension") writeFileSync(join(f.state, "active-lease"), JSON.stringify({ id: handoffId, expiry: Date.now() + 60000 }));
      if (fault === "witness-replaced") {
        renameSync(f.witnessPath, f.witnessPath + ".original");
        writeFileSync(f.witnessPath, f.originalWitness, { mode: 0o600 });
      }
      if (fault === "generation-drift") {
        writeFileSync(join(f.state, "scenario"), "recovery-generation-before-marker");
        writeFileSync(join(f.state, "start-count"), "1");
      }
      const result = runOwner(f, ["--recover"]);
      assert.notEqual(result.status, 0, result.stdout);
      assert.deepEqual(readFileSync(f.journal), f.originalJournal);
      assert.deepEqual(readFileSync(f.witnessPath), f.originalWitness);
      assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
      assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|gateway\.suspend\.(prepare|resume|handoff)|account\.openclaw-deploy/);
    });
  }

  for (const boundary of ["stopped-before-selection", "selected-before-C"]) {
    test(`interruption at ${boundary} recovers the stopped predecessor from B`, t => {
      const f = deploymentFixture(t);
      if (boundary === "selected-before-C") observeCurrentPublication(f, true);
      else {
        const delegate = f.commandPaths.systemctl + ".delegate";
        renameSync(f.commandPaths.systemctl, delegate);
        executable(f.commandPaths.systemctl, `
'${delegate}' "$@"
if [[ "$1" == stop && ! -e '${join(f.state, "cutover-crashed")}' ]]; then
  : >'${join(f.state, "cutover-crashed")}'
  kill -KILL "$FIXTURE_OWNER_PID"
  exit 137
fi`);
      }
      const interrupted = runOwner(f, ["--interrupt-after-drain"]);
      assert.notEqual(interrupted.status, 0, interrupted.stdout);
      const journal = JSON.parse(readFileSync(f.journal));
      assert.equal(journal.phase, "B_PREVIOUS_PUBLISHED");
      const witness = readFileSync(join(f.serving, "journal", journal.originalWitness.name));
      const result = runOwner(f, ["--recover"]);
      assert.equal(result.status, 0, result.stderr + events(f));
      assert.match(result.stdout, /RECOVERED phase=B_PREVIOUS_PUBLISHED action=restored-stopped-predecessor/);
      assert.equal(existsSync(f.journal), false);
      assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
      assert.deepEqual(readFileSync(join(f.serving, "journal", journal.originalWitness.name)), witness);
      assert.equal(readFileSync(join(f.state, "start-count"), "utf8"), "1");
    });
  }

  for (const properties of [{ RestartKillSignal: "12" }, { NFileDescriptorStore: "1" },
    { RuntimeDirectory: "owned-state" }, { PartOf: "other.service" }]) {
    test(`incompatible stop/start semantics refuse ${Object.keys(properties)[0]} before stop`, t => {
      const f = deploymentFixture(t);
      writeFileSync(join(f.state, "stop-start-properties"), JSON.stringify(properties));
      const result = runOwner(f, ["--interrupt-after-drain"]);
      assert.notEqual(result.status, 0, result.stdout);
      assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
      assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
    });
  }
});

describe("Team migration rollback ownership", () => {
  function runMigrationOwner(t, action, failure = "") {
    const f = makeReleaseFixture(t), journal = join(f.state, "migration-journal");
    writeFileSync(journal, "retained original witness");
    const source = readFileSync(process.env.TEAM_OWNER_TEST_SOURCE ?? join(owner, "openclaw-release-deploy"), "utf8");
    const functions = ["restore_migration_topology", ...(action === "recover" ? ["recover_journal"] : [])]
      .map(name => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0]);
    assert.ok(functions.every(Boolean));
    const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const program = `set -euo pipefail
journal_file=${quote(journal)}; trace=${quote(join(f.state, "migration-trace"))}
releases_root=${quote(join(f.serving, "releases"))}; serving_root=${quote(f.serving)}
current_link=${quote(join(f.serving, "current"))}; root_uid=0; config_file=fixture; state_database=fixture
reconcile_config_hash=""; reconcile_request=""; mode=recover; session_witness="original-captured-witness"
system_active=${action === "restore" ? "active" : "inactive"}; user_active=inactive
held_suspension=lease; predecessor_stopped=0; suspension_state=DRAINING
failure=${quote(failure)}
event() { printf '%s\\n' "$*" >>"$trace"; }
fail() { printf '%s\\n' "$*" >&2; return 1; }
proof() {
  case "$1" in
  journal-field)
    case "$3" in
    services.system.unitFileState) echo disabled ;; services.user.unitFileState) echo enabled ;;
    services.system.activeState) echo inactive ;; services.user.activeState) echo active ;;
    phase) echo MIGRATION_SWITCHING ;; predecessor.sha) echo ${before} ;; candidate.sha) echo ${after} ;;
    topology) echo migration-user ;; process.pid) echo 111 ;; process.generation) echo 1110 ;; protectedPaths) echo '[]' ;;
    *) return 97 ;; esac ;;
  worker-config|migration-status) echo none ;;
  journal-read|validate-release|policy) echo '{}' ;;
  gateway-runtime) echo no ;;
  compatibility) event compatible ;;
  unlink-exact) event retired; rm "$journal_file" ;;
  *) return 98 ;; esac
}
system_state() { echo "$system_active"; }; user_state() { echo "$user_active"; }
prepare_rollback_suspension() { event prepared-draining; }
assert_protected_identity() { :; }; assert_policy() { :; }; check_suspension() { event checked; }
arm_suspension_handoff() { event arm; [[ "$failure" != handoff ]]; }
system_systemctl() { [[ "$1" == stop ]]; event system-stop; system_active=inactive; }
restore_pointer_topology() { event pointers; }
restore_migration_enablement() { [[ "$1 $2" == 'disabled enabled' ]]; event enablement; }
assert_exclusive_owner() {
  if [[ "$1" == quiescent ]]; then [[ "$system_active $user_active" == 'inactive inactive' ]];
  else [[ "$1 $system_active $user_active" == 'migration-user inactive active' ]]; fi
}
user_systemctl() { [[ "$1" == start ]]; event user-start; user_active=active; }
resume_suspension() { event resumed; }
migration_check_existing_guard() { :; }; load_journal_witness() { :; }
read_pointer() { echo "$releases_root/${after}"; }
wait_for_live() {
  [[ "$1 $2 $3 $session_witness" == "$releases_root/${before} {} migration-user original-captured-witness" ]] || return 1
  event verified
  [[ "$failure" != verification ]]
}
${functions.join("\n")}
${action === "restore" ? "restore_migration_topology" : "recover_journal"} || exit $?
`;
    const result = spawnSync("bash", ["-c", program], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    return { result, journal, trace: readFileSync(join(f.state, "migration-trace"), "utf8").trim().split("\n") };
  }
  for (const failure of ["", "handoff"]) test(`migration rollback ${failure ? "refuses a rejected" : "arms the"} draining successor handoff before stop`, t => {
    const { result, journal, trace } = runMigrationOwner(t, "restore", failure);
    if (failure) {
      assert.equal(readFileSync(journal, "utf8"), "retained original witness");
      assert.notEqual(result.status, 0);
      assert.equal(trace.includes("system-stop"), false);
      assert.equal(trace.includes("user-start"), false);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(trace.indexOf("arm") >= 0 && trace.indexOf("arm") < trace.indexOf("system-stop"), trace);
      assert.ok(trace.indexOf("system-stop") < trace.indexOf("user-start"), trace);
    }
  });
  for (const failure of ["", "verification"]) test(`stopped migration recovery ${failure ? "retains its journal when verification fails" : "verifies its predecessor before journal retirement"}`, t => {
    const { result, journal, trace } = runMigrationOwner(t, "recover", failure);
    assert.ok(trace.includes("verified"), trace);
    if (failure) {
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(journal, "utf8"), "retained original witness");
      assert.equal(trace.includes("retired"), false);
      assert.doesNotMatch(result.stdout, /RECOVERED/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(trace.indexOf("verified") < trace.indexOf("retired"), trace);
      assert.equal(existsSync(journal), false);
      assert.match(result.stdout, /RECOVERED phase=MIGRATION_SWITCHING action=restored-user-topology/);
    }
  });
});

function optionalProfileFixture(t, failure = "") {
  const f = deploymentFixture(t);
  const delegate = f.env.OPENCLAW_TEAM_RELEASE_LIB;
  const library = join(f.root, "optional-profile-shim.mjs");
  f.profileTrace = join(f.state, "profile-trace");
  // This double proves shell policy and ordering only. Linux proof owns profile filesystem effects.
  writeFileSync(library, `
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), failure = ${JSON.stringify(failure)};
const journal = ${JSON.stringify(f.journal)}, trace = ${JSON.stringify(f.profileTrace)};
const inspection = ${JSON.stringify(join(f.state, "profile-inspection"))};
const observed = ${JSON.stringify(join(f.state, "profile-observed"))};
const marker = ${JSON.stringify(join(f.serving, "verified", after))};
const refuse = label => { process.stderr.write('synthetic ' + label + ' failure\\n'); process.exit(failure.endsWith(':uncertain') ? 137 : 1); };
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (args[0] === 'startup-profile') {
  const command = args[1], input = JSON.parse(readFileSync(0, 'utf8'));
  appendFileSync(trace, JSON.stringify({ command, input, journal: existsSync(journal), marker: existsSync(marker) }) + '\\n');
  if (failure === command || (failure.startsWith(command + ':') &&
    (command !== 'verify-environment' || failure === command + ':' +
      (input.armed ? 'preparation' : 'admission') + ':uncertain'))) refuse(command);
  if (command === 'inspect') {
    assert.equal(input.mode, 'steady');
    assert.equal(JSON.parse(readFileSync(journal)).phase, 'B_PREVIOUS_PUBLISHED');
    assert.equal(readFileSync(${JSON.stringify(join(f.state, "system"))}, 'utf8'), 'active');
    const result = { ...input, before: { unit: 'synthetic-inspection-baseline' } };
    writeFileSync(inspection, JSON.stringify(result));
    emit(result);
  } else if (command === 'no-effects') {
    assert.deepEqual(Object.keys(input), ['operation']);
    assert.equal(existsSync(inspection), false);
    emit({ operation: input.operation, outcome: 'skipped-no-effect' });
  } else if (command === 'prepare' || command === 'close-arm') {
    assert.deepEqual(input, JSON.parse(readFileSync(inspection, 'utf8')));
    if (command === 'prepare') {
      assert.equal(JSON.parse(readFileSync(journal)).phase, 'C_CURRENT_SELECTED');
      assert.equal(readFileSync(${JSON.stringify(join(f.state, "system"))}, 'utf8'), 'inactive');
    }
    if (command === 'close-arm' && failure.endsWith(':unsafe-close')) refuse('close-arm');
    emit({ operation: input.operation, outcome: command === 'prepare' ? 'prepared' : 'closed' });
  } else if (command === 'verify-closed') {
    assert.deepEqual(input.request, JSON.parse(readFileSync(inspection, 'utf8')));
    assert.deepEqual(input.receipt, { operation: input.request.operation, outcome: 'closed' });
    emit(input.receipt);
  } else if (command === 'strict-observation') {
    const degraded = input.readiness.eventLoop.degraded || input.channels.eventLoop.degraded;
    assert.equal(input.convergenceState, degraded ? 'READY_CPU_DEGRADED_OPERATOR_WAIVED' : 'READY');
    assert.equal(input.channelState, input.channels.eventLoop.degraded ? 'CHANNELS_CPU_DEGRADED_OPERATOR_WAIVED' : 'CHANNELS_OK');
    if (!degraded) writeFileSync(observed, input.operation);
    emit({ operation: input.operation, outcome: degraded ? 'ineligible-load' : 'strict-observed' });
  } else if (command === 'terminalize-arm') {
    assert.equal(readFileSync(observed, 'utf8'), input.operation);
    emit({ operation: input.operation, outcome: 'terminal-eligible' });
  } else if (['admit', 'disarm', 'verify-environment'].includes(command)) {
    emit({ operation: input.operation });
  } else throw Error('unsupported synthetic profile command: ' + command);
} else {
  if (args[0] === 'unlink-exact' && args[1] === journal && failure === 'journal-retirement') refuse('journal-retirement');
  const result = spawnSync(process.execPath, [${JSON.stringify(delegate)}, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`);
  f.env.OPENCLAW_TEAM_RELEASE_LIB = library;
  if (["marker-publication", "release-cleanup"].includes(failure)) {
    const node = join(f.commands, "node-closeout-failure");
    executable(node, `
if [[ "$1" == -e && -f '${join(f.state, "profile-observed")}' ]]; then
  if [[ '${failure}' == marker-publication && "\${@: -2:1}" == record ]] ||
     [[ '${failure}' == release-cleanup && "\${@: -1}" == list ]]; then
    printf 'synthetic ${failure} failure\\n' >&2
    exit 74
  fi
fi
exec '${process.execPath}' "$@"`);
    f.env.OPENCLAW_TEAM_NODE_BIN = node;
  }
  return f;
}

function profileCalls(f) {
  return existsSync(f.profileTrace) ? readFileSync(f.profileTrace, "utf8").trim().split("\n").map(JSON.parse) : [];
}

function assertOptionalDeploymentAccepted(f, result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + events(f));
  assert.match(result.stdout, new RegExp(`SUCCESS sha=${after} action=deploy`));
  assert.equal(readlinkSync(join(f.serving, "current")), join(f.serving, "releases", after));
  assert.equal(existsSync(f.journal), false);
  assert.equal(readFileSync(join(f.serving, "verified", after), "utf8"), after + "\n");
  assert.equal(readFileSync(join(f.state, "start-count"), "utf8"), "1");
  assert.equal(events(f).split("gateway gateway call agent\n").length - 1, 1);
  assert.doesNotMatch(result.stdout, /ROLLBACK/);
}

describe("Team optional steady profile shell policy", () => {
  const args = ["--arm-steady-profile", "--allow-cpu-degraded", "--interrupt-after-drain"];

  for (const reason of ["cpu", "event_loop_utilization", "event_loop_delay"]) {
    test(`${reason} accepts the successor once and closes only the optional profile`, t => {
      const f = optionalProfileFixture(t);
      writeFileSync(join(f.state, "event-loop"), JSON.stringify({
        degraded: true, reasons: [reason], intervalMs: 1000, delayP99Ms: 1000,
        delayMaxMs: 1000, utilization: 1, cpuCoreRatio: 1.5, degradedSinceMs: 0,
      }));
      const result = runOwner(f, args);
      assertOptionalDeploymentAccepted(f, result);
      assert.match(result.stdout, /CPU_DEGRADED_OPERATOR_WAIVED/);
      assert.match(result.stdout, /STEADY_PROFILE_SKIPPED .*outcome=closed/);
      assert.deepEqual(profileCalls(f).map(call => call.command).filter(command =>
        ["strict-observation", "close-arm", "verify-closed", "terminalize-arm"].includes(command)),
      ["strict-observation", "close-arm", "verify-closed"]);
    });
  }

  test("strict observation becomes eligible only after marker publication, journal retirement and SUCCESS", t => {
    const f = optionalProfileFixture(t);
    const result = runOwner(f, args);
    assertOptionalDeploymentAccepted(f, result);
    const calls = profileCalls(f);
    const observed = calls.find(call => call.command === "strict-observation");
    const terminal = calls.find(call => call.command === "terminalize-arm");
    assert.equal(observed.journal, true);
    assert.equal(observed.marker, false);
    assert.equal(terminal.journal, false);
    assert.equal(terminal.marker, true);
    assert.ok(result.stdout.indexOf("SUCCESS sha=") < result.stdout.indexOf('"outcome":"terminal-eligible"'));
    assert.equal(calls.some(call => call.command === "close-arm"), false);
  });

  for (const failure of ["inspect", "inspect:uncertain"]) {
    test(`read-only inspection${failure.endsWith(":uncertain") ? " with uncertain supervisor exit" : ""} refusal needs no cleanup baseline and preserves ordinary activation`, t => {
      const f = optionalProfileFixture(t, failure);
      const result = runOwner(f, args);
      assertOptionalDeploymentAccepted(f, result);
      assert.match(result.stdout, /outcome=skipped-no-effect phase=inspection/);
      assert.deepEqual(profileCalls(f).map(call => call.command), ["inspect", "no-effects"]);
      assert.equal(events(f).split("service.system.stop\n").length - 1, 1);
      assert.equal(events(f).split("service.system.start\n").length - 1, 1);
      assert.doesNotMatch(events(f), /service\.system\.restart/);
    });
  }

  for (const phase of ["preparation", "admission"]) {
    test(`read-only environment ${phase} failure closes the arm and accepts the successor`, t => {
      const f = optionalProfileFixture(t, `verify-environment:${phase}:uncertain`);
      const result = runOwner(f, args);
      assertOptionalDeploymentAccepted(f, result);
      assert.match(result.stderr, /synthetic verify-environment failure/);
      const calls = profileCalls(f);
      assert.equal(calls.filter(call => call.command === "verify-environment").at(-1).input.armed,
        phase === "preparation");
      assert.deepEqual(calls.slice(-2).map(call => call.command), ["close-arm", "verify-closed"]);
      assert.equal(calls.some(call => call.command === "terminalize-arm"), false);
    });
  }

  for (const failure of ["prepare", "admit", "strict-observation"]) {
    test(`${failure} refusal closes the arm and keeps one accepted successor`, t => {
      const f = optionalProfileFixture(t, failure);
      const result = runOwner(f, args);
      assertOptionalDeploymentAccepted(f, result);
      assert.match(result.stdout, /STEADY_PROFILE_SKIPPED .*outcome=closed/);
      const calls = profileCalls(f);
      assert.deepEqual(calls.slice(-2).map(call => call.command), ["close-arm", "verify-closed"]);
      assert.equal(calls.some(call => call.command === "terminalize-arm"), false);
      if (failure === "prepare") assert.equal(calls.some(call => call.command === "admit"), false);
    });
  }

  for (const failure of ["prepare", "admit"]) {
    test(`unsafe ${failure} cleanup retains the journal without rollback mutations`, t => {
      const f = optionalProfileFixture(t, `${failure}:unsafe-close`);
      const result = runOwner(f, args);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /optional profile closure is unverified/);
      assert.equal(existsSync(f.journal), true);
      assert.equal(readlinkSync(join(f.serving, "current")), join(f.serving, "releases", after));
      assert.equal(existsSync(join(f.serving, "verified", after)), false);
      assert.deepEqual(events(f).split("\n").filter(event => /^service.system.(stop|start|restart)$/.test(event)),
        failure === "prepare" ? ["service.system.stop"] : ["service.system.stop", "service.system.start"]);
      assert.equal(profileCalls(f).some(call => call.command === "terminalize-arm"), false);
    });
  }

  for (const failure of ["health", "rpc", "channel", "marker"]) {
    test(`${failure} failure stays a deployment failure and closes the optional arm`, t => {
      const f = optionalProfileFixture(t);
      if (failure === "marker") writeFileSync(join(f.state, "scenario"), "marker-wrong-session");
      else writeFileSync(join(f.state, `${failure}-failure`), "1");
      if (failure !== "marker") {
        f.env.OPENCLAW_TEAM_VERIFICATION_BUDGET = "60";
        f.ownerTimeoutMs = 180_000;
      }
      const result = runOwner(f, args);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, {
        health: /Gateway healthz proof is malformed or unhealthy/,
        rpc: /synthetic Gateway RPC failure/,
        channel: /discord\/controller-test-agent is not exactly ready/,
        marker: /stage=marker.reply-check/,
      }[failure]);
      assert.doesNotMatch(result.stdout, /SUCCESS sha=/);
      assert.equal(existsSync(join(f.serving, "verified", after)), false);
      const calls = profileCalls(f).map(call => call.command);
      assert.ok(calls.includes("close-arm"));
      assert.ok(calls.includes("verify-closed"));
      assert.equal(calls.includes("terminalize-arm"), false);
      assert.equal(calls.includes("strict-observation"), false);
    });
  }

  for (const failure of ["marker-publication", "journal-retirement", "release-cleanup"]) {
    test(`${failure} after strict observation cannot publish capture eligibility`, t => {
      const f = optionalProfileFixture(t, failure);
      const result = runOwner(f, args);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, new RegExp(`synthetic ${failure} failure`));
      assert.doesNotMatch(result.stdout, /SUCCESS sha=/);
      const calls = profileCalls(f).map(call => call.command);
      assert.ok(calls.includes("strict-observation"));
      assert.deepEqual(calls.slice(-2), ["close-arm", "verify-closed"]);
      assert.equal(calls.includes("terminalize-arm"), false);
      assert.equal(existsSync(f.journal), failure !== "release-cleanup");
      assert.equal(readFileSync(join(f.state, "start-count"), "utf8"), "1");
    });
  }

  for (const failure of ["prepare", "admit", "strict-observation", "terminalize-arm"]) {
    test(`${failure} uncertain supervisor exit prevents every later owner mutation`, t => {
      const f = optionalProfileFixture(t, `${failure}:uncertain`);
      const result = runOwner(f, args);
      assert.ifError(result.error);
      assert.equal(result.status, 76, result.stdout + result.stderr);
      assert.match(result.stderr, new RegExp(`synthetic ${failure} failure`));
      const calls = profileCalls(f).map(call => call.command);
      assert.equal(calls.at(-1), failure);
      assert.equal(calls.includes("close-arm"), false);
      assert.equal(existsSync(f.journal), failure !== "terminalize-arm");
      assert.equal(readlinkSync(join(f.serving, "current")), join(f.serving, "releases", after));
      const expectedActions = failure === "prepare"
        ? ["service.system.stop"] : ["service.system.stop", "service.system.start"];
      assert.deepEqual(events(f).split("\n").filter(event => /^service.system.(stop|start|restart)$/.test(event)), expectedActions);
      assert.doesNotMatch(events(f), /gateway gateway call gateway.suspend.resume/);
      assert.equal(existsSync(join(f.serving, "verified", after)), failure === "terminalize-arm");
    });
  }
});

test("prepared steady profile closes with its original pre-selection inspection", {
  skip: process.platform !== "linux" || process.getuid() !== 0 ? "requires disposable Linux root" : false,
}, t => {
  const f = preparedActivationFixture(t, "B_PREVIOUS_PUBLISHED");
  const platform = join(f.root, "profile-platform");
  for (const name of ["var/lib", "run/systemd/system", "proc/self/fd", "proc/self/fdinfo", "proc/sys/kernel/random"])
    mkdirSync(join(platform, name), { recursive: true, mode: 0o755 });
  writeFileSync(join(platform, "run/openclaw-release-deploy.lock"), "", { mode: 0o600 });
  writeFileSync(join(platform, "proc/sys/kernel/random/boot_id"), handoffId);
  writeProcess(platform, 111, 1110);
  writeProcess(platform, 444, 4440);
  writeFileSync(join(platform, "proc/111/environ"), "PATH=/usr/bin\0");
  symlinkSync(process.execPath, join(platform, "proc/111/exe"));
  const stopped = join(f.state, "profile-stopped"), preload = join(f.root, "profile-platform.mjs");
  // Model only Linux/systemd inputs; the actual CLI owns inspection, publication and closure.
  writeFileSync(preload, `
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const root = ${JSON.stringify(platform)}, stopped = ${JSON.stringify(stopped)};
const native = { ...fs }, run = childProcess.spawnSync;
const virtualAncestors = new Set(['/var', '/var/lib', '/run', '/run/systemd', '/run/openclaw-release-deploy.lock']);
const virtualRoots = ['/var/lib/openclaw-team-diagnostics', '/run/systemd/system', '/proc'];
const map = value => typeof value === 'string' && (virtualAncestors.has(value) ||
  virtualRoots.some(prefix => value === prefix || value.startsWith(prefix + '/'))) ? root + value : value;
for (const name of ['existsSync', 'lstatSync', 'statSync', 'readFileSync', 'openSync', 'mkdirSync',
  'chmodSync', 'chownSync', 'unlinkSync', 'rmSync', 'statfsSync'])
  fs[name] = (path, ...args) => native[name](map(path), ...args);
for (const name of ['linkSync', 'renameSync']) fs[name] = (a, b, ...args) => native[name](map(a), map(b), ...args);
fs.realpathSync = (path, ...args) => {
  const value = native.realpathSync(map(path), ...args);
  return value.startsWith(root + '/') ? value.slice(root.length) : value;
};
fs.readdirSync = (path, ...args) => path === '/proc/self/fd' ? ['9'] : native.readdirSync(map(path), ...args);
fs.fstatSync = (fd, ...args) => fd === 9 ? native.lstatSync(root + '/run/openclaw-release-deploy.lock') : native.fstatSync(fd, ...args);
fs.readFileSync = (path, ...args) => path === '/proc/self/fdinfo/9'
  ? 'flags:\\t02000000\\nlock: 1: FLOCK ADVISORY WRITE 444 00:00:1 0 EOF\\n'
  : native.readFileSync(map(path), ...args);
childProcess.spawnSync = (command, args, options) => {
  if (command !== '/usr/bin/busctl') return run(command, args, options);
  if (args.includes('Reload')) return { status: 0, stdout: '', stderr: '' };
  const properties = {
    Environment: [], PassEnvironment: [], UnsetEnvironment: [], EnvironmentFiles: [],
    ExecStart: [[process.execPath, [process.execPath, ${JSON.stringify(join(f.serving, "current/dist/index.js"))}, 'gateway', '--port', '18789'], false]],
    WorkingDirectory: ${JSON.stringify(f.serving)}, Type: 'simple', User: 'openclaw', Group: 'openclaw',
    KillMode: 'control-group', KillSignal: 15, RestartKillSignal: 15,
    FileDescriptorStoreMax: 0, NFileDescriptorStore: 0, ControlPID: 0, Job: [0, '/'],
    MainPID: native.existsSync(stopped) ? 0 : 111, ActiveState: native.existsSync(stopped) ? 'inactive' : 'active',
  };
  return { status: 0, stdout: JSON.stringify({ data: properties[args.at(-1)] ?? [] }), stderr: '' };
};
syncBuiltinESMExports();
`);
  const run = (command, input) => spawnSync(process.execPath,
    ["--import", preload, f.library, "startup-profile", command], {
      env: f.env, input: JSON.stringify(input), encoding: "utf8", timeout: 30_000,
    });
  const success = result => {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const request = {
    operation: handoffId, mode: "steady", activation: f.journal, journal: join(f.serving, "journal"),
    release: f.candidate, releaseIdentity: JSON.parse(f.originalJournal).candidate,
    predecessor: { pid: 111, start: "1110" }, owner: { pid: 444, start: "4440" }, uid: 1000, gid: 1000,
  };
  const inspected = success(run("inspect", request));
  releaseProof(f, "journal-phase", f.journal, "C_CURRENT_SELECTED", f.originalJournal.toString());
  rmSync(join(f.serving, "current")); symlinkSync(f.candidate, join(f.serving, "current"));
  rmSync(join(platform, "proc/111"), { recursive: true }); writeFileSync(stopped, "stopped");
  success(run("prepare", inspected));
  const directory = join(platform, "var/lib/openclaw-team-diagnostics", handoffId);
  const record = JSON.parse(readFileSync(join(directory, "record.json")));
  assert.equal(record.activation.sha256, createHash("sha256").update(JSON.stringify(JSON.parse(readFileSync(f.journal)))).digest("hex"));
  const receipt = success(run("close-arm", inspected));
  assert.equal(receipt.outcome, "closed");
  assert.deepEqual(success(run("verify-closed", { request: inspected, receipt })), receipt);
  assert.equal(JSON.parse(readFileSync(join(directory, "record.json"))).arm.state, "closed");
  assert.equal(existsSync(join(platform, "run/systemd/system/openclaw-gateway.service.d", `zz-team-cpu-profile-${handoffId}.conf`)), false);
});

describe("Team suspension preparation failure diagnostics", () => {
  const privateText = "synthetic-private-config-auth-message";
  const requestFailure = reason => JSON.stringify({ ok: false, error: {
    type: "gateway_request_error", code: "UNAVAILABLE", message: privateText,
    details: { reason, privateText }, retryable: true,
  } });
  const cases = [
    ["conflict", 1, requestFailure("gateway-suspension-conflict"), "gateway-conflict"],
    ["recovery", 1, requestFailure("scheduler-resume-failed"), "scheduler-recovery"],
    ["other request", 7, requestFailure(privateText), "gateway-request"],
    ["credentials", 1, JSON.stringify({ ok: false, error: { type: "gateway_credentials_required", message: privateText } }), "gateway-credentials"],
    ["transport", 1, JSON.stringify({ ok: false, error: { type: "gateway_transport_error", kind: "timeout", message: privateText }, gateway: { url: privateText } }), "gateway-transport"],
    ["outer timeout", 124, "", "timeout-exit"],
    ["killed command", 137, privateText, "killed-exit"],
    ["malformed output", 1, `{${privateText}`, "unclassified"],
    ["unknown error", 1, JSON.stringify({ ok: false, error: { type: privateText, message: privateText } }), "unclassified"],
    ["oversized output", 1, requestFailure("gateway-suspension-conflict") + " ".repeat(20_000), "unclassified"],
    ["renewal", 1, requestFailure("gateway-suspension-conflict"), "gateway-conflict", true],
  ];
  for (const [name, exit, stdout, category, renewal = false] of cases) {
    test(`${name} retains only fixed preparation diagnostics and never cuts over`, t => {
      const f = deploymentFixture(t);
      writeFileSync(join(f.state, "prepare-failure"), JSON.stringify({
        exit, stdout, renewal, stderr: "synthetic existing private stderr retained\n",
      }));
      const config = readFileSync(f.configPath);
      const result = runOwner(f);
      assert.ifError(result.error);
      assert.equal(result.status, 75, result.stderr + events(f));
      assert.match(result.stdout, /DEFERRED renewable preserve-only drain preparation unavailable or conflicting/);
      const diagnostic = result.stderr.split("\n").filter(line => line.startsWith("SUSPENSION_PREPARE_FAILED"));
      assert.deepEqual(diagnostic, [`SUSPENSION_PREPARE_FAILED stage=${renewal ? "renewal" : "initial"} exit=${exit} category=${category}`]);
      assert.match(result.stderr, /synthetic existing private stderr retained/);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(privateText));
      assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
      assert.deepEqual(readFileSync(f.configPath), config);
      assert.equal(existsSync(f.journal), false);
      assert.equal(existsSync(join(f.state, "active-lease")), false);
      assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
      assert.equal(events(f).includes("gateway gateway call gateway.suspend.resume\n"), renewal);
    });
  }
});

describe("Team verified release retention and recovery refusal", () => {
  test("successful deployment records a private verified marker after full acceptance", (t) => {
    const f = deploymentFixture(t);
    const failed = join(f.serving, "failed", after);
    writeFileSync(failed, after + "\n", { mode: 0o600 });
    const result = runOwner(f);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, new RegExp(`SUCCESS sha=${after} action=deploy`));
    const marker = join(f.serving, "verified", after);
    assert.equal(readFileSync(marker, "utf8"), after + "\n");
    assert.equal(lstatSync(marker).mode & 0o777, 0o600);
    assert.equal(lstatSync(marker).uid, process.getuid());
    assert.equal(lstatSync(marker).gid, process.getgid());
    assert.equal(lstatSync(join(f.serving, "verified")).mode & 0o777, 0o700);
    assert.equal(existsSync(f.journal), false);
    assert.equal(events(f).split("service.system.stop\n").length - 1, 1);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    assert.equal(existsSync(join(f.serving, "verified", before)), false);
    assert.equal(readFileSync(failed, "utf8"), after + "\n");
  });

  test("failed marker publication retains the journal and recovery completes the marker before retirement", (t) => {
    const f = deploymentFixture(t);
    const node = join(f.commands, "node-marker-failure");
    executable(node, `
if [[ "$1" == -e && "\${@: -2:1}" == record ]]; then
  printf 'synthetic marker publication failure\\n' >&2
  exit 74
fi
exec '${process.execPath}' "$@"`);
    f.env.OPENCLAW_TEAM_NODE_BIN = node;
    const failed = runOwner(f);
    assert.ifError(failed.error);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /synthetic marker publication failure/);
    assert.equal(JSON.parse(readFileSync(f.journal, "utf8")).phase, "D_VERIFYING");
    assert.equal(existsSync(join(f.serving, "verified", after)), false);
    assert.equal(readlinkSync(join(f.serving, "current")), join(f.serving, "releases", after));
    f.env.OPENCLAW_TEAM_NODE_BIN = process.execPath;
    const recovered = runOwner(f, ["--recover"]);
    assert.equal(recovered.status, 0, recovered.stderr + events(f));
    assert.match(recovered.stdout, /RECOVERED phase=D_VERIFYING action=verified-no-restart/);
    assert.equal(readFileSync(join(f.serving, "verified", after), "utf8"), after + "\n");
    assert.equal(existsSync(f.journal), false);
    assert.equal(events(f).split("service.system.stop\n").length - 1, 1);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    assert.doesNotMatch(events(f), /service\.system\.restart/);
  });

  test("cleanup retains the newest three verification mtimes and prunes an older fourth", (t) => {
    const f = makeReleaseFixture(t);
    const shas = ["b", "c", "d", "e"].map((value) => value.repeat(40));
    for (const [index, sha] of shas.entries()) {
      f.addRelease(sha);
      // Reverse release mtimes to prove retention uses verification time.
      utimesSync(join(f.serving, "releases", sha), 100 + index, 100 + index);
      verificationMarker(f, sha, 100000 - index * 1000);
    }
    const stale = verificationMarker(f, "f".repeat(40));
    const result = runOwner(f, ["--cleanup"]);
    assert.equal(result.status, 0, result.stderr);
    for (const sha of shas.slice(0, 3)) {
      assert.equal(existsSync(join(f.serving, "releases", sha)), true, sha);
      assert.equal(existsSync(join(f.serving, "verified", sha)), true, sha);
    }
    // Linux non-root cannot move a sealed directory between parents; the real owner retains it.
    const retainedByPlatform = process.platform === "linux" && process.getuid() !== 0;
    assert.equal(existsSync(join(f.serving, "releases", shas[3])), retainedByPlatform);
    assert.equal(existsSync(join(f.serving, "verified", shas[3])), retainedByPlatform);
    if (retainedByPlatform) assert.match(result.stderr, /RETAIN replacement-safe quarantine refused/);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(f.initial), true);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
  });

  for (const location of ["published", "quarantined"]) test(`cleanup retires an obsolete ${location} failed release but preserves its outcome`, (t) => {
    if (process.platform === "linux" && process.getuid() !== 0) {
      t.skip("sealed release quarantine requires Linux root");
      return;
    }
    const f = makeReleaseFixture(t);
    for (const [index, value] of ["b", "c", "d", "e"].entries()) {
      const sha = value.repeat(40);
      f.addRelease(sha);
      verificationMarker(f, sha, 100000 - index * 1000);
    }
    const failed = join(f.serving, "failed", "e".repeat(40));
    writeFileSync(failed, "e".repeat(40) + "\n", { mode: 0o600 });
    const release = join(f.serving, "releases", "e".repeat(40));
    const identity = lstatSync(release);
    const quarantine = join(f.serving, "quarantine", `${"e".repeat(40)}.${identity.dev}.${identity.ino}`);
    if (location === "quarantined")
      releaseProof(f, "quarantine", release, quarantine, String(process.getuid()), String(identity.dev), String(identity.ino));
    const result = runOwner(f, ["--cleanup"]);
    assert.equal(result.status, 0, result.stderr);
    for (const value of ["b", "c", "d"]) {
      assert.equal(existsSync(join(f.serving, "releases", value.repeat(40))), true);
    }
    assert.equal(existsSync(release), false);
    assert.equal(existsSync(quarantine), process.platform !== "linux");
    assert.equal(existsSync(join(f.serving, "verified", "e".repeat(40))), false);
    assert.equal(readFileSync(failed, "utf8"), "e".repeat(40) + "\n");
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
  });

  test("cleanup preserves current, previous, verified, pinned and journal-referenced failed releases", (t) => {
    const f = failedReleaseFixture(t, true);
    const previous = "d".repeat(40), pinned = "e".repeat(40);
    f.addRelease(previous);
    f.addRelease(pinned);
    // Keep the journal candidate distinct from every current retention pointer.
    for (const [name, sha] of [["current", before], ["previous", previous]]) {
      rmSync(join(f.serving, name));
      symlinkSync(join(f.serving, "releases", sha), join(f.serving, name));
    }
    verificationMarker(f, verifiedTarget);
    writeFileSync(join(f.serving, "pins", pinned), pinned + "\n", { mode: 0o600 });
    const shas = [before, after, verifiedTarget, previous, pinned];
    for (const sha of shas)
      writeFileSync(join(f.serving, "failed", sha), sha + "\n", { mode: 0o600 });
    const journal = readFileSync(f.journal);
    const result = runOwner(f, ["--cleanup"]);
    assert.equal(result.status, 0, result.stderr);
    for (const sha of shas) {
      assert.equal(existsSync(join(f.serving, "releases", sha)), true, sha);
      assert.equal(readFileSync(join(f.serving, "failed", sha), "utf8"), sha + "\n");
    }
    assert.deepEqual(readFileSync(f.journal), journal);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
  });

  test("cleanup retains another-filesystem release before validation or quarantine", (t) => {
    const f = makeReleaseFixture(t), release = f.addRelease(after);
    const trace = join(f.root, "external-release-trace"), library = join(f.root, "external-release-library.mjs");
    writeFileSync(library, `
import { lstatSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), release = ${JSON.stringify(release)};
if (args[0] === 'stat-identity' && args[1] === release) {
  const entry = lstatSync(release);
  process.stdout.write((entry.dev + 1) + ' ' + entry.ino);
} else {
  if (args[1] === release && ['validate-release', 'quarantine'].includes(args[0]))
    appendFileSync(${JSON.stringify(trace)}, args[0] + '\\n');
  const result = spawnSync(process.execPath, [${JSON.stringify(f.library)}, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`);
    f.env.OPENCLAW_TEAM_RELEASE_LIB = library;
    const result = runOwner(f, ["--cleanup"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`RETAIN different-filesystem release=${after}`));
    assert.equal(existsSync(trace), false, "retained external storage must not be scanned or moved");
    assert.equal(existsSync(release), true);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
  });

  test("cleanup refuses unsafe verification marker permissions before pruning releases", (t) => {
    const f = makeReleaseFixture(t);
    f.addRelease(after);
    const marker = verificationMarker(f, after);
    chmodSync(marker, 0o666);
    const result = runOwner(f, ["--cleanup"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /verified marker ownership, type, or permissions are unsafe/);
    assert.equal(existsSync(join(f.serving, "releases", after)), true);
  });

  test("failing current without a verified marker names the missing precondition", (t) => {
    const f = failedReleaseFixture(t);
    assertUnchangedRecovery(f, runOwner(f, ["--recover", "--sha", verifiedTarget]), /missing precondition: requested release must carry a valid root-owned verified\/ marker/);
  });

  test("failing current refuses the journal candidate as a recovery target", (t) => {
    const f = failedReleaseFixture(t);
    verificationMarker(f, after);
    assertUnchangedRecovery(f, runOwner(f, ["--recover", "--sha", after]), /missing precondition: requested SHA must be distinct from the journal candidate/);
  });

  test("failing current names a missing exact SHA or absent on-disk release", (t) => {
    const f = failedReleaseFixture(t);
    for (const args of [["--recover"], ["--recover", "--sha", "../escape"]]) {
      assertUnchangedRecovery(f, runOwner(f, args), /missing precondition: --sha must name one exact verified release SHA/);
    }
    assertUnchangedRecovery(f, runOwner(f, ["--recover", "--sha", "f".repeat(40)]), /missing precondition: requested release must exist on disk/);
  });

  test("a verified marker cannot bypass the sealed release validator", (t) => {
    const f = failedReleaseFixture(t);
    verificationMarker(f, verifiedTarget);
    chmodSync(join(f.serving, "releases", verifiedTarget, "dist", "index.js"), 0o777);
    assertUnchangedRecovery(f, runOwner(f, ["--recover", "--sha", verifiedTarget]), /missing precondition: requested release must be sealed-valid/);
  });

  test("failing current and verified target identify the owned-restart and durable-transition blockers", (t) => {
    const f = failedReleaseFixture(t);
    verificationMarker(f, verifiedTarget);
    assertUnchangedRecovery(f, runOwner(f, ["--recover", "--sha", verifiedTarget]), /missing precondition: owned restart.*third-release recovery requires a durable journal transition/);
  });

  for (const [scenario, args] of [["success", ["--recover", "--sha", verifiedTarget]], ["user-manager-offline", ["--recover"]], ["channel-client-auth-held", ["--recover"]]]) test(`live current keeps full verified-no-restart recovery unchanged: ${scenario}`, (t) => {
    const f = failedReleaseFixture(t, true, scenario);
    if (scenario === "channel-client-auth-held") f.env.OPENCLAW_TEAM_VERIFICATION_BUDGET = "30";
    if (process.env.TEAM_OWNER_TEST_SOURCE) f.owner = process.env.TEAM_OWNER_TEST_SOURCE;
    verificationMarker(f, verifiedTarget);
    const result = runOwner(f, args);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, /RECOVERED phase=ROLLBACK_FAILED action=verified-current-candidate-no-restart/);
    const probe = JSON.parse(readFileSync(join(f.state, "channel-probe-params"), "utf8"));
    assert.equal(probe.probe, true);
    assert.ok(Number.isInteger(probe.timeoutMs) && probe.timeoutMs > 0);
    assert.equal(existsSync(f.journal), false);
    assert.equal(readlinkSync(join(f.serving, "current")), join(f.serving, "releases", after));
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|account\.openclaw-deploy/);
  });

  test("the real recovery guard rejects third-release topology, retaining its exact journal", (t) => {
    const f = failedReleaseFixture(t);
    verificationMarker(f, verifiedTarget);
    const original = readFileSync(f.journal);
    const record = releaseProof(f, "journal-read", f.journal);
    const evidence = releaseProof(f, "recovery-snapshot", f.journal, f.serving, record, "selected");
    for (const [name, sha] of [["previous", after], ["current", verifiedTarget]]) {
      rmSync(join(f.serving, name));
      symlinkSync(join(f.serving, "releases", sha), join(f.serving, name));
    }
    const result = spawnSync(process.execPath, [f.library, "recovery-finish", f.journal, evidence, f.serving, "selected"], {
      encoding: "utf8", env: f.env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recovery did not retain exact selected candidate topology/);
    assert.deepEqual(readFileSync(f.journal), original);
  });
});


describe("Team explicit restored-config reconciliation", () => {
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  function fixture(t) {
    const f = failedReleaseFixture(t, true);
    rmSync(join(f.serving, "current")); symlinkSync(f.initial, join(f.serving, "current"));
    rmSync(join(f.serving, "previous")); writeFileSync(join(f.state, "running"), before);
    const config = JSON.parse(readFileSync(f.configPath));
    config.tools.media = { audio: { language: "en" } };
    writeFileSync(f.configPath + ".new", JSON.stringify(config), { mode: 0o600 });
    renameSync(f.configPath + ".new", f.configPath);
    const witness = releaseProof(f, "session-preservation-witness", f.initial, f.initial, f.databasePath);
    f.witnessPath = join(f.serving, "journal", "original-12345678-1234-4234-8234-123456789abc.json");
    writeFileSync(f.witnessPath, witness, { mode: 0o600 });
    const entry = lstatSync(f.witnessPath), record = JSON.parse(readFileSync(f.journal));
    record.originalWitness = { name: f.witnessPath.split("/").at(-1), device: entry.dev, inode: entry.ino, sha256: hash(witness) };
    writeFileSync(f.journal, JSON.stringify(record), { mode: 0o600 });
    f.witnessBytes = readFileSync(f.witnessPath);
    f.configBytes = readFileSync(f.configPath);
    f.journalBytes = readFileSync(f.journal);
    f.reconcileArgs = ["--recover", "--reconcile-config", before, String(f.pid), f.start,
      hash(f.configBytes), hash(f.journalBytes)];
    return f;
  }
  function preparedFixture(t) {
    const f = preparedActivationFixture(t, "C_CURRENT_SELECTED", "restored", true);
    replacementPredecessor(f);
    const config = JSON.parse(f.originalConfigBytes);
    config.ui = { prefs: { sidebarEntries: ["chat", "sessions"] } };
    writeFileSync(f.configPath + ".new", JSON.stringify(config), { mode: 0o600 });
    renameSync(f.configPath + ".new", f.configPath);
    f.configBytes = readFileSync(f.configPath);
    f.journalBytes = f.originalJournal;
    f.witnessBytes = f.originalWitness;
    f.reconcileArgs = ["--recover", "--reconcile-config", before, "222", "2220",
      hash(f.configBytes), hash(f.journalBytes)];
    return f;
  }
  test("prepared recovery preserves a reviewed UI preference replacement and retires C without a restart", t => {
    const f = preparedFixture(t);
    const identities = [f.configPath, f.databasePath, join(f.serving, "current"), join(f.serving, "previous")]
      .map(path => [path, lstatSync(path).dev, lstatSync(path).ino]);
    const strict = runOwner(f, ["--recover"]);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /protected configuration or SQLite device\/inode identity changed/);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
    const result = runOwner(f, f.reconcileArgs);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, /RECOVERY_CONFIG_RECONCILED/);
    assert.match(result.stdout, /RECOVERED phase=C_CURRENT_SELECTED action=restore-pointer-no-restart suspension=RESTARTED session-proof=original-pre-cutover/);
    assert.equal(existsSync(f.journal), false);
    assert.deepEqual(readFileSync(f.configPath), f.configBytes);
    assert.deepEqual(readFileSync(f.witnessPath), f.witnessBytes);
    for (const [path, device, inode] of identities) {
      assert.equal(lstatSync(path).dev, device); assert.equal(lstatSync(path).ino, inode);
    }
    assert.equal(events(f).split("gateway gateway call agent\n").length - 1, 1);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|gateway\.suspend\.(prepare|resume|handoff)|account\.openclaw-deploy/);
  });
  for (const [fault, mutate] of [
    ["stopped recovery option", f => { f.reconcileArgs = ["--recover", "--reconcile-stopped-predecessor", before, hash(f.configBytes), hash(f.journalBytes)]; }],
    ["original process still present", f => { writeProcess(f.root, f.pid, f.start); }],
    ["wrong replacement generation", f => { f.reconcileArgs[4] = "2221"; }],
    ["changed config hash", f => { f.reconcileArgs[5] = "0".repeat(64); }],
    ["changed database identity", f => {
      writeFileSync(f.databasePath + ".new", readFileSync(f.databasePath)); renameSync(f.databasePath + ".new", f.databasePath);
    }],
    ["unrestored previous pointer", f => { rmSync(join(f.serving, "previous")); symlinkSync(f.initial, join(f.serving, "previous")); }],
    ["matching active suspension", f => { writeFileSync(join(f.state, "active-lease"), JSON.stringify({ id: handoffId, expiry: Date.now() + 60000 })); }],
    ["foreign active suspension", f => { writeFileSync(join(f.state, "active-lease"), JSON.stringify({ id: "foreign-lease", expiry: Date.now() + 60000 })); }],
  ]) test(`prepared config reconciliation refuses ${fault} without changing authored state`, t => {
    const f = preparedFixture(t); mutate(f);
    const result = runOwner(f, f.reconcileArgs);
    assert.ifError(result.error); assert.notEqual(result.status, 0, result.stdout);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
    assert.deepEqual(readFileSync(f.configPath), f.configBytes);
    assert.deepEqual(readFileSync(f.witnessPath), f.witnessBytes);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|gateway\.suspend\.(prepare|resume|handoff)|account\.openclaw-deploy/);
  });
  test("retains ordinary identity refusal but explicitly verifies the restored predecessor with reviewed config", t => {
    const f = fixture(t);
    const strict = runOwner(f, ["--recover"]);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /protected configuration or SQLite device\/inode identity changed/);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
    const result = runOwner(f, f.reconcileArgs);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, /RECOVERY_CONFIG_RECONCILED/);
    assert.match(result.stdout, /RECOVERED phase=ROLLBACK_FAILED action=verified-restored-predecessor-no-restart/);
    assert.equal(existsSync(f.journal), false);
    assert.deepEqual(readFileSync(f.configPath), f.configBytes);
    assert.deepEqual(readFileSync(f.witnessPath), f.witnessBytes);
    assert.match(result.stdout, /session-proof=original-pre-cutover/);
    assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|account\.openclaw-deploy/);
  });
  function coldFixture(t) {
    const f = fixture(t);
    for (const [name, value] of [["system", "failed"], ["pid", "0"], ["listener-pid", "0"]])
      writeFileSync(join(f.state, name), value);
    rmSync(join(f.root, "proc", String(f.pid)), { recursive: true });
    const database = new DatabaseSync(f.databasePath);
    database.exec("CREATE TABLE schema_meta (meta_key TEXT, role TEXT, schema_version INTEGER, agent_id TEXT); INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL)");
    database.close();
    f.stoppedArgs = ["--recover", "--reconcile-stopped-predecessor", before, hash(f.configBytes), hash(f.journalBytes)];
    return f;
  }
  test("a cold restored predecessor starts once through its native owner and verifies without changing config or pointers", t => {
    const f = coldFixture(t);
    const result = runOwner(f, f.stoppedArgs);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, /RECOVERED phase=ROLLBACK_FAILED action=started-restored-predecessor/);
    assert.match(result.stdout, /MARKER_VERIFIED/);
    assert.equal(existsSync(f.journal), false);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    assert.doesNotMatch(events(f), /service\..*\.(stop|restart)|account\.openclaw-deploy/);
    assert.deepEqual(readFileSync(f.configPath), f.configBytes);
    assert.deepEqual(readFileSync(f.witnessPath), f.witnessBytes);
    assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
    assert.equal(existsSync(join(f.serving, "previous")), false);
  });
  for (const fault of ["shared-newer", "agent-newer", "shared-metadata", "agent-metadata-missing", "registry-newer", "registry-owner-conflict", "system-job", "user-control", "missing-permit", "writable-fd", "writable-map"]) {
    test(`cold recovery refuses ${fault} before any start`, t => {
      const f = coldFixture(t);
      if (fault.endsWith("newer") || fault === "shared-metadata") {
        const db = new DatabaseSync(fault === "agent-newer" ? f.agentDatabasePath : f.databasePath);
        if (fault === "registry-newer") {
          db.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT, schema_version INTEGER)");
          db.prepare("INSERT INTO agent_databases VALUES (?, ?, 2)").run("controller-test-agent", f.agentDatabasePath);
        } else if (fault === "shared-metadata") db.exec("UPDATE schema_meta SET schema_version=2");
        else db.exec("PRAGMA user_version=2; UPDATE schema_meta SET schema_version=2");
        db.close();
      }
      if (fault === "system-job") writeFileSync(join(f.state, "system-job"), "123");
      if (fault === "agent-metadata-missing") {
        const db = new DatabaseSync(f.agentDatabasePath); db.exec("DROP TABLE schema_meta"); db.close();
      }
      if (fault === "registry-owner-conflict") {
        const db = new DatabaseSync(f.databasePath);
        db.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT, schema_version INTEGER)");
        db.prepare("INSERT INTO agent_databases VALUES (?, ?, 1)").run("different-agent", f.agentDatabasePath);
        db.close();
      }
      if (fault === "user-control") writeFileSync(join(f.state, "user-control-pid"), "123");
      if (fault === "missing-permit") rmSync(f.permit);
      if (fault.startsWith("writable-")) {
        const process = join(f.root, "proc", "777");
        mkdirSync(join(process, "fd"), { recursive: true }); mkdirSync(join(process, "fdinfo"));
        writeFileSync(join(process, "maps"), fault === "writable-map" ? `0-1 rw-s 0000 00:00 1 ${f.agentDatabasePath}\n` : "");
        if (fault === "writable-fd") {
          symlinkSync(f.databasePath, join(process, "fd", "3")); writeFileSync(join(process, "fdinfo", "3"), "flags:\t02\n");
        }
      }
      const result = runOwner(f, f.stoppedArgs);
      assert.notEqual(result.status, 0, result.stdout);
      assert.deepEqual(readFileSync(f.journal), f.journalBytes);
      assert.deepEqual(readFileSync(f.configPath), f.configBytes);
      assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
    });
  }
  test("a condition-skipped start consumes the attempt and cannot be blindly issued again", t => {
    const f = coldFixture(t); writeFileSync(join(f.state, "scenario"), "start-skip0");
    const first = runOwner(f, f.stoppedArgs);
    assert.notEqual(first.status, 0);
    assert.match(first.stderr, /intent and journal retained; repeat start refused/);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
    const second = runOwner(f, f.stoppedArgs);
    assert.notEqual(second.status, 0);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
  });
  test("interrupted receipt publication settles only its exact alias and never reissues a start", t => {
    const f = coldFixture(t);
    const intent = join(f.serving, "journal", `recovery-start-${hash(f.journalBytes)}.json`);
    const preload = join(f.root, "interrupt-receipt.mjs");
    writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const link=fs.linkSync; fs.linkSync=function(a,b){const result=link(a,b);if(b===${JSON.stringify(intent)})process.exit(73);return result;};syncBuiltinESMExports();`);
    f.env.NODE_OPTIONS = `--import=${preload}`;
    const interrupted = runOwner(f, f.stoppedArgs);
    delete f.env.NODE_OPTIONS;
    assert.notEqual(interrupted.status, 0);
    assert.equal(lstatSync(intent).nlink, 2);
    const receipt = readFileSync(intent);
    assert.doesNotMatch(events(f), /service.system.start/);
    const stopped = runOwner(f, f.stoppedArgs);
    assert.notEqual(stopped.status, 0);
    assert.equal(lstatSync(intent).nlink, 1);
    assert.deepEqual(readFileSync(intent), receipt);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
    assert.doesNotMatch(events(f), /service.system.start/);
    // Model a later already-running predecessor; this invocation may verify it, never start it.
    writeProcess(f.root, 333, 3330); symlinkSync(f.initial, join(f.root, "proc/333/cwd"));
    for (const [name, value] of [["system", "active"], ["pid", "333"], ["listener-pid", "333"]]) writeFileSync(join(f.state, name), value);
    const verified = runOwner(f, f.stoppedArgs);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /action=verified-restored-predecessor-no-restart/);
    assert.doesNotMatch(events(f), /service.system.start/);
    assert.equal(existsSync(f.journal), false);
  });
  test("a start with a pending control job retains its journal until the same owner can be verified", t => {
    const f = coldFixture(t); writeFileSync(join(f.state, "scenario"), "start-pending-job");
    const first = runOwner(f, f.stoppedArgs);
    assert.notEqual(first.status, 0);
    assert.match(first.stderr, /control jobs have not settled/);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
    writeFileSync(join(f.state, "system-job"), "0");
    const second = runOwner(f, f.stoppedArgs);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
  });
  test("an uncertain start acknowledgment is resolved by full same-generation verification, not another start", t => {
    const f = coldFixture(t); writeFileSync(join(f.state, "scenario"), "start-uncertain");
    const result = runOwner(f, f.stoppedArgs);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, /RECOVERY_START_REQUEST result=7 repeat-start=refused/);
    assert.match(result.stdout, /MARKER_VERIFIED/);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    assert.equal(existsSync(f.journal), false);
  });
  test("after a started predecessor fails verification, recovery verifies it without a second start", t => {
    const f = coldFixture(t); writeFileSync(join(f.state, "scenario"), "marker-wrong-session");
    const first = runOwner(f, f.stoppedArgs);
    assert.notEqual(first.status, 0);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
    writeFileSync(join(f.state, "scenario"), "success");
    const second = runOwner(f, f.stoppedArgs);
    assert.equal(second.status, 0, second.stderr + events(f));
    assert.match(second.stdout, /action=verified-restored-predecessor-no-restart/);
    assert.equal(events(f).split("service.system.start\n").length - 1, 1);
    assert.equal(existsSync(f.journal), false);
  });
  for (const [fault, mutate, reason] of [
    ["config hash", f => { f.reconcileArgs[5] = "c".repeat(64); }, /reviewed reconciliation config bytes changed/],
    ["journal hash", f => { f.reconcileArgs[6] = "c".repeat(64); }, /config reconciliation journal bytes changed/],
    ["PID", f => { f.reconcileArgs[3] = "222"; }, /process generation changed/],
    ["generation", f => { f.reconcileArgs[4] = "2220"; }, /process generation changed/],
    ["release", f => { f.reconcileArgs[2] = after; }, /expected restored predecessor/],
    ["database replacement", f => {
      writeFileSync(f.databasePath + ".new", readFileSync(f.databasePath)); renameSync(f.databasePath + ".new", f.databasePath);
    }, /recovery protected path identity changed/],
    ["witness replacement", f => { writeFileSync(f.witnessPath, "[]"); }, /original session witness/],
    ["exposed config", f => { chmodSync(f.configPath, 0o644); }, /exact owner-safe regular file/],
    ["missing original witness", f => {
      const record = JSON.parse(f.journalBytes); delete record.originalWitness;
      writeFileSync(f.journal, JSON.stringify(record)); f.journalBytes = readFileSync(f.journal);
      f.reconcileArgs[6] = hash(f.journalBytes);
    }, /exact reviewed restored-system rollback/],
    ["nonterminal phase", f => {
      const record = JSON.parse(f.journalBytes); record.phase = "A_PREPARED";
      writeFileSync(f.journal, JSON.stringify(record)); f.journalBytes = readFileSync(f.journal);
      f.reconcileArgs[6] = hash(f.journalBytes);
    }, /retained failed rollback journal/],
    ["selected candidate", f => {
      rmSync(join(f.serving, "current")); symlinkSync(join(f.serving, "releases", after), join(f.serving, "current"));
    }, /expected restored predecessor/],
    ["policy", f => {
      const config = JSON.parse(f.configBytes); config.tools.exec.mode = "deny";
      writeFileSync(f.configPath, JSON.stringify(config)); f.reconcileArgs[5] = hash(readFileSync(f.configPath));
    }, /policy is invalid/],
    ["marker", f => { writeFileSync(join(f.state, "scenario"), "marker-wrong-session"); }, /marker.reply-check/],
  ]) test(`rejects ${fault} without rewriting recovery evidence`, t => {
    const f = fixture(t); mutate(f);
    const config = readFileSync(f.configPath);
    const result = runOwner(f, f.reconcileArgs);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, reason);
    assert.deepEqual(readFileSync(f.journal), f.journalBytes);
    assert.deepEqual(readFileSync(f.configPath), config);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|account\.openclaw-deploy/);
  });
  test("reconciliation is an explicit recovery operation, never a timer or alternate-target option", t => {
    const f = fixture(t);
    for (const args of [f.reconcileArgs.slice(1), [...f.reconcileArgs, "--sha", before],
      [...f.reconcileArgs, ...f.reconcileArgs.slice(1)], [...f.reconcileArgs.slice(0, -1), ""]]) {
      const result = runOwner(f, args);
      assert.notEqual(result.status, 0, result.stdout);
      assert.deepEqual(readFileSync(f.journal), f.journalBytes);
      assert.equal(events(f), "");
    }
  });
  for (const [context, makeFixture] of [["rollback", fixture], ["prepared", preparedFixture]]) {
    for (const fault of ["config bytes", "config inode", "database inode", "journal bytes", "pointer inode", "wrong view"]) {
      test(`${context} admitted evidence refuses later ${fault} drift before journal retirement`, t => {
        const f = makeFixture(t);
        const request = JSON.stringify({ config: { path: f.configPath, sha256: hash(f.configBytes) },
          databasePath: f.databasePath, journalSha256: hash(f.journalBytes), runtimeUid: f.runtimeUid });
        const evidence = releaseProof(f, "recovery-snapshot", f.journal, f.serving, f.journalBytes.toString(), "restored", request);
        if (fault === "config bytes") writeFileSync(f.configPath, f.configBytes.toString() + "\n");
        if (fault === "config inode" || fault === "database inode") {
          const path = fault === "config inode" ? f.configPath : f.databasePath;
          writeFileSync(path + ".new", readFileSync(path), { mode: 0o600 }); renameSync(path + ".new", path);
        }
        if (fault === "journal bytes") writeFileSync(f.journal, f.journalBytes.toString() + "\n");
        if (fault === "pointer inode") {
          symlinkSync(f.initial, join(f.serving, "current.new")); renameSync(join(f.serving, "current.new"), join(f.serving, "current"));
        }
        const journal = readFileSync(f.journal);
        const result = spawnSync(process.execPath, [f.library, "recovery-finish", f.journal, evidence, f.serving,
          fault === "wrong view" ? "selected" : "restored"], { encoding: "utf8", env: f.env });
        assert.notEqual(result.status, 0, fault);
        assert.deepEqual(readFileSync(f.journal), journal);
      });
    }
  }
});

describe("Team history gaps warn without blocking deployment", () => {
  function originalWitness(f, gaps = 1) {
    const db = new DatabaseSync(f.agentDatabasePath);
    for (let index = 1; index < gaps; index++) db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, ?, NULL)").run(
      `agent:controller-test-agent:fixture-${index}`, `window-${index}`, JSON.stringify({ sessionId: `window-${index}`, updatedAt: 1 }), 1);
    db.close();
    const release = join(f.serving, "releases", after);
    const witness = releaseProof(f, "session-preservation-witness", release, release, f.databasePath);
    const path = join(f.serving, "journal", "original-12345678-1234-4234-8234-123456789abc.json");
    writeFileSync(path, witness, { mode: 0o600 });
    const st = lstatSync(path), record = JSON.parse(readFileSync(f.journal));
    record.originalWitness = { name: path.split("/").at(-1), device: st.dev, inode: st.ino,
      sha256: createHash("sha256").update(witness).digest("hex") };
    writeFileSync(f.journal, JSON.stringify(record), { mode: 0o600 });
    const current = new DatabaseSync(f.agentDatabasePath); current.exec("DELETE FROM session_nodes"); current.close();
    return { path, witness };
  }
  for (const position of ["selected", "restored"]) test(`${position} failed rollback recovers with bounded warnings and retains original witness`, t => {
    const f = failedReleaseFixture(t, true), original = originalWitness(f, 12);
    if (position === "restored") {
      rmSync(join(f.serving, "current")); symlinkSync(f.initial, join(f.serving, "current"));
      rmSync(join(f.serving, "previous"));
      writeFileSync(join(f.state, "running"), before);
    }
    const result = runOwner(f, ["--recover"]);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stderr, /WARNING HISTORY_PRESERVATION_GAPS count=12 shown=8 historical-bytes=unverified/);
    assert.equal(result.stderr.split("HISTORY_PRESERVATION_GAP diagnostic=").length - 1, 8);
    assert.match(result.stdout, /RECOVERED phase=ROLLBACK_FAILED/);
    assert.equal(existsSync(f.journal), false);
    assert.equal(readFileSync(original.path, "utf8"), original.witness);
    assert.doesNotMatch(result.stderr, /agent:controller-test-agent:fixture-|window-11/);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
  });
  test("ordinary cutover proceeds when a captured logical session retires", t => {
    const f = deploymentFixture(t);
    writeFileSync(join(f.state, "scenario"), "lose-session-on-start");
    const result = runOwner(f);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, new RegExp(`SUCCESS sha=${after} action=deploy`));
    assert.match(result.stderr, /WARNING HISTORY_PRESERVATION_GAPS count=1/);
    assert.equal(existsSync(f.journal), false);
  });
  test("a surviving logical key warns for lost captured history and accepts its preserved archive", t => {
    const f = makeReleaseFixture(t), key = "agent:controller-test-agent:existing";
    const session = "synthetic-generation", generation = "captured-generation";
    const db = new DatabaseSync(f.agentDatabasePath);
    db.prepare("INSERT INTO session_windows VALUES (?, ?)").run(session, key);
    db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?, ?)").run(session, generation);
    db.close();
    const witness = releaseProof(f, "session-preservation-witness", f.initial, f.initial, f.databasePath);
    const changed = new DatabaseSync(f.agentDatabasePath);
    changed.prepare("UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?")
      .run("next-window", JSON.stringify({ sessionId: "next-window", updatedAt: 1 }), key);
    changed.prepare("DELETE FROM transcript_rewrite_watermarks WHERE session_id = ?").run(session);
    changed.close();
    const verify = () => {
      const result = spawnSync(process.execPath,
        [f.library, "session-preservation-verify", f.initial, f.initial, f.databasePath],
        { env: f.env, input: witness, encoding: "utf8", timeout: 30_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result;
    };
    const missing = verify();
    assert.equal(missing.stdout.trim(), "SESSIONS_HISTORY_WARNING count=1");
    assert.match(missing.stderr, /WARNING HISTORY_PRESERVATION_GAPS count=1/);
    assert.match(missing.stderr, /exact-owner-generation-missing/);
    assert.doesNotMatch(missing.stderr, /agent:controller-test-agent:existing|synthetic-generation/);
    const retained = Buffer.from("synthetic retained transcript"), archive = new DatabaseSync(f.agentDatabasePath);
    archive.prepare("INSERT INTO session_transcript_archives VALUES (?, ?, ?, ?, ?, ?)")
      .run(session, generation, key, retained, createHash("sha256").update(retained).digest("hex"), "identity");
    archive.close();
    const preserved = verify();
    assert.equal(preserved.stdout.trim(), "SESSIONS_PRESERVED");
    assert.doesNotMatch(preserved.stderr, /HISTORY_PRESERVATION/);
  });
  for (const fault of ["table-missing", "witness-replaced", "database-replaced"]) test(`${fault} remains fatal and retains the exact journal`, t => {
    const f = failedReleaseFixture(t, true), original = originalWitness(f), journal = readFileSync(f.journal);
    if (fault === "table-missing") {
      const db = new DatabaseSync(f.agentDatabasePath); db.exec("DROP TABLE session_nodes"); db.close();
    } else if (fault === "witness-replaced") writeFileSync(original.path, "[]");
    else {
      const bytes = readFileSync(f.agentDatabasePath), originalInode = lstatSync(f.agentDatabasePath).ino;
      renameSync(f.agentDatabasePath, f.agentDatabasePath + ".original");
      writeFileSync(f.agentDatabasePath, bytes, { mode: 0o600 });
      assert.notEqual(lstatSync(f.agentDatabasePath).ino, originalInode);
    }
    const result = runOwner(f, ["--recover"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.deepEqual(readFileSync(f.journal), journal);
    assert.doesNotMatch(result.stdout, /RECOVERED/);
  });
});


describe("Team marker terminal observation", () => {
  test("a truncated reply cannot verify an exact marker or retire recovery evidence", t => {
    const f = failedReleaseFixture(t, true);
    writeFileSync(join(f.state, "scenario"), "marker-truncated");
    const journal = readFileSync(f.journal);
    const result = runOwner(f, ["--recover"]);
    assert.ifError(result.error);
    const accepted = JSON.parse(readFileSync(join(f.state, "marker-accepted"), "utf8"));
    const marker = accepted.message.split(": ").at(-1);
    const output = JSON.parse(readFileSync(join(f.state, "marker-output"), "utf8"));
    assert.equal(output.observation.stopReason, "length");
    assert.deepEqual(output.observation.terminalReply, { disposition: "visible", text: marker });
    assert.equal(output.payloads[0].text, marker);
    assert.match(output.payloads[1].text, /Reply truncated/);
    assert.notEqual(result.status, 0, result.stdout);
    assert.deepEqual(readFileSync(f.journal), journal);
    assert.equal(events(f).split("gateway gateway call agent\n").length - 1, 1);
    assert.doesNotMatch(result.stdout, /MARKER_VERIFIED|RECOVERED/);
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
  });
  test("a completed exact marker without a stop reason remains accepted under a private umask", t => {
    const previousUmask = process.umask(0o077);
    let f;
    try {
      f = failedReleaseFixture(t, true);
    } finally {
      process.umask(previousUmask);
    }
    writeFileSync(join(f.state, "scenario"), "marker-no-stop-reason");
    const result = runOwner(f, ["--recover"]);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stdout, /MARKER_VERIFIED/);
    assert.equal(existsSync(f.journal), false);
  });
  test("preserves the existing agentMeta model contract when provider response naming differs", t => {
    const f=failedReleaseFixture(t,true);writeFileSync(join(f.state,"scenario"),"marker-response-model-alias");
    const result=runOwner(f,["--recover"]);
    assert.equal(result.status,0,result.stderr+events(f));
    assert.match(result.stdout,/MARKER_VERIFIED/);
    assert.equal(existsSync(f.journal),false);
  });
  test("one accepted run uses paced immediate observations while pending", t => {
    const f=failedReleaseFixture(t,true);writeFileSync(join(f.state,"scenario"),"marker-stream-close");
    const result=runOwner(f,["--recover"]);
    assert.equal(result.status,0,result.stderr+events(f));
    assert.match(result.stdout,/MARKER_VERIFIED .*observation=agent.wait/);
    assert.equal(events(f).split("gateway gateway call agent\n").length-1,1);
    assert.equal(events(f).split("gateway gateway call agent.wait\n").length-1,2);
    const observations=JSON.parse(readFileSync(join(f.state,"marker-observations"),"utf8"));
    assert.deepEqual(observations.map(({timeoutMs,clientTimeoutMs})=>({timeoutMs,clientTimeoutMs})),[
      {timeoutMs:0,clientTimeoutMs:60000},{timeoutMs:0,clientTimeoutMs:60000},
    ]);
    assert.ok(BigInt(observations[1].atNs)-BigInt(observations[0].atNs)>=10_000_000_000n,"pending snapshots must not spin");
    assert.doesNotMatch(events(f),/gateway agent\n/);
    assert.equal(existsSync(f.journal),false);
  });
  for(const [label,error] of [
    ["timeout",{name:"GatewayTransportError",kind:"timeout",timeoutMs:60000,connectionDetails:{}}],
    ["abnormal close",{name:"GatewayTransportError",kind:"closed",code:1006,connectionDetails:{}}],
    ["service restart close",{name:"GatewayTransportError",kind:"closed",code:1012,connectionDetails:{}}],
    ["unreachable socket",{name:"GatewayTransportError",kind:"closed",connectionDetails:{}}],
  ]) test(`a typed observation ${label} reobserves the same run and preserves acceptance`, t => {
    const f=failedReleaseFixture(t,true);
    writeFileSync(join(f.state,"marker-rpc-failure"),JSON.stringify({method:"agent.wait",error,once:true}));
    const result=runOwner(f,["--recover"]);assert.ifError(result.error);
    assert.equal(result.status,0,result.stderr+events(f));
    assert.match(result.stderr,/MARKER_OBSERVATION_RETRY/);
    assert.doesNotMatch(result.stderr,/synthetic private transport detail/);
    assert.equal(events(f).split("gateway gateway call agent\n").length-1,1);
    assert.equal(events(f).split("gateway gateway call agent.wait\n").length-1,2);
    const observations=JSON.parse(readFileSync(join(f.state,"marker-observations"),"utf8"));
    assert.ok(observations.every(row=>row.timeoutMs===0&&row.clientTimeoutMs===60000));
    assert.ok(BigInt(observations[1].atNs)-BigInt(observations[0].atNs)>=10_000_000_000n);
    assert.equal(existsSync(f.journal),false);
    assert.doesNotMatch(events(f),/service\..*\.(stop|start|restart)/);
  });
  for(const [label,failure] of [
    ["unacknowledged dispatch timeout",{method:"agent",error:{name:"GatewayTransportError",kind:"timeout",connectionDetails:{}}}],
    ["authentication error",{method:"agent.wait",error:{name:"GatewayClientRequestError",gatewayCode:"UNAUTHORIZED"}}],
    ["protocol close",{method:"agent.wait",error:{name:"GatewayTransportError",kind:"closed",code:1002,connectionDetails:{}}}],
    ["policy close",{method:"agent.wait",error:{name:"GatewayTransportError",kind:"closed",code:1008,connectionDetails:{}}}],
    ["generation drift after timeout",{method:"agent.wait",error:{name:"GatewayTransportError",kind:"timeout",connectionDetails:{}},generationChange:true}],
  ]) test(`${label} refuses without redispatch or journal retirement`, t => {
    const f=failedReleaseFixture(t,true),journal=readFileSync(f.journal);
    writeFileSync(join(f.state,"marker-rpc-failure"),JSON.stringify({...failure,once:true}));
    const result=runOwner(f,["--recover"]);assert.ifError(result.error);
    assert.notEqual(result.status,0,result.stdout);
    assert.deepEqual(readFileSync(f.journal),journal);
    assert.equal(events(f).split("gateway gateway call agent\n").length-1,1);
    assert.equal(events(f).split("gateway gateway call agent.wait\n").length-1,failure.method==="agent"?0:1);
    assert.doesNotMatch(result.stdout,/MARKER_VERIFIED|RECOVERED/);
    assert.doesNotMatch(events(f),/service\..*\.(stop|start|restart)/);
  });
  test("an untyped observation failure retains recovery evidence without another observation", t => {
    const f=failedReleaseFixture(t,true);writeFileSync(join(f.state,"scenario"),"marker-wait-transport-error");
    const journal=readFileSync(f.journal),result=runOwner(f,["--recover"]);
    assert.ifError(result.error);assert.notEqual(result.status,0,result.stdout);
    assert.deepEqual(readFileSync(f.journal),journal);
    assert.equal(events(f).split("gateway gateway call agent\n").length-1,1);
    assert.equal(events(f).split("gateway gateway call agent.wait\n").length-1,1);
    assert.match(result.stderr,/stage=marker.wait /);
    assert.doesNotMatch(result.stdout,/MARKER_VERIFIED|RECOVERED/);
    assert.doesNotMatch(events(f),/service\..*\.(stop|start|restart)/);
  });
  for(const scenario of ["marker-wrong-session","marker-wrong-model","marker-missing-receipt","marker-error-with-reply","marker-abort-with-reply","marker-pending-with-receipt","marker-generation-change","marker-generation-change-after-wait"]) test(scenario+" cannot retire recovery evidence",t=>{
    const f=failedReleaseFixture(t,true);writeFileSync(join(f.state,"scenario"),scenario);const journal=readFileSync(f.journal);
    const result=runOwner(f,["--recover"]);assert.notEqual(result.status,0,result.stdout);assert.deepEqual(readFileSync(f.journal),journal);
    assert.equal(events(f).split("gateway gateway call agent\n").length-1,1);assert.doesNotMatch(result.stdout,/RECOVERED/);
  });
});
