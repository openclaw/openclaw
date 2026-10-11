import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ownerPath = process.env.MARKER_DEADLINE_TEST_OWNER ??
  join(dirname(fileURLToPath(import.meta.url)), "openclaw-release-deploy");

// Exercise the actual shell control flow with synthetic external effects and time.
// This does not prove GNU timeout, process capabilities, or live Gateway behavior.
function ownerFunction(source, name) {
  const declarations = [...source.matchAll(/^([a-zA-Z_][a-zA-Z_0-9]*)\(\) \{/gm)];
  const index = declarations.findIndex((match) => match[1] === name);
  assert.notEqual(index, -1, `missing owner function ${name}`);
  return source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length);
}

function deadlineRecovery(t, terminalAtMs, failure = null, admissionReadyAtMs = 0) {
  const root = mkdtempSync(join(tmpdir(), "team-marker-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "journal.json"), events = join(root, "events.jsonl");
  const before = "a".repeat(40), after = "b".repeat(40);
  const original = JSON.stringify({ phase: "ROLLBACK_FAILED", topology: "system",
    predecessor: { sha: before }, candidate: { sha: after },
    process: { pid: 123, generation: 456 }, protectedPaths: {} });
  writeFileSync(journal, original);
  symlinkSync(join(root, after), join(root, "current"));
  const helper = join(root, "helper.mjs");
  writeFileSync(helper, String.raw`
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root=process.env.FIXTURE_ROOT, [kind,...args]=process.argv.slice(2);
const emit=value=>process.stdout.write(JSON.stringify(value));
const record=value=>appendFileSync(join(root,"events.jsonl"),JSON.stringify(value)+"\n");
if(kind==="proof") {
  const [operation,...rest]=args;
  switch(operation) {
    case "worker-config": case "migration-status": process.stdout.write("none"); break;
    case "journal-read": process.stdout.write(readFileSync(rest[0],"utf8")); break;
    case "journal-field": {
      const value=rest[1].split(".").reduce((value,key)=>value[key],JSON.parse(readFileSync(rest[0],"utf8")));
      process.stdout.write(typeof value==="object"?JSON.stringify(value):String(value)); break;
    }
    case "journal-original-witness": case "recovery-snapshot": emit({}); break;
    case "validate-release": emit({buildId:"fixture"}); break;
    case "policy": emit({model:"fixture/exact-model"}); break;
    case "approvals": process.stdout.write("0"); break;
    case "session-preservation-verify": case "compatibility": case "recovery-check": break;
    case "recovery-finish": record({kind:operation}); unlinkSync(rest[0]); break;
    default: throw Error("unexpected proof operation "+operation);
  }
} else if(kind==="rpc") {
  const [method,raw,clientBudget,clock]=args,params=JSON.parse(raw),atMs=Number(clock);
  record({kind:method,atMs,clientBudget:Number(clientBudget),nativeWait:params.timeoutMs,idempotencyKey:params.idempotencyKey});
  if(method==="agent") {
    if(atMs<Number(process.env.FIXTURE_ADMISSION_READY_AT_MS)) {process.stdout.write("RETRYABLE_ADMISSION_PENDING");process.exit(76);}
    writeFileSync(join(root,"accepted.json"),raw);
    emit({status:"accepted",runId:"fixture-run",agentId:params.agentId,sessionKey:params.sessionKey});
  } else {
    assert.equal(method,"agent.wait"); assert.equal(params.runId,"fixture-run");
    const failure=JSON.parse(process.env.FIXTURE_OBSERVATION_FAILURE);
    if(failure) {process.stdout.write(failure.output);process.exit(failure.exit);}
    if(atMs<Number(process.env.FIXTURE_TERMINAL_AT_MS)) emit({runId:params.runId,status:"timeout"});
    else {
      const accepted=JSON.parse(readFileSync(join(root,"accepted.json"),"utf8"));
      emit({runId:params.runId,status:"ok",endedAt:atMs,stopReason:"stop",
        terminalReply:{disposition:"visible",text:accepted.message.split(": ").at(-1)},
        terminalReceipt:{runId:params.runId,sessionId:accepted.sessionId,turnId:"fixture-turn",
          terminalDisposition:"visible",effective:{provider:"fixture",model:"exact-model"}}});
    }
  }
} else if(kind==="pause") {
  const [at,budget,seconds]=args,ms=Number(seconds)*1000;
  assert.ok(Number.isInteger(ms)&&ms>0); assert.ok(ms<=Number(budget)*1000);
  record({kind,atMs:Number(at),ms,budgetMs:Number(budget)*1000});
  process.stdout.write(String(ms));
} else throw Error("unexpected helper operation "+kind);
`);
  const source = readFileSync(ownerPath, "utf8");
  const functions = ["verification_failure", "verification_step", "verify_marker",
    "load_journal_witness", "wait_for_live", "recover_journal"].map((name) => ownerFunction(source, name)).join("\n");
  const script = String.raw`
set -Eeuo pipefail
unset SECONDS
SECONDS=0
clock_ms=0
verification_budget=600
mode=recover
reconcile_config_hash=""
reconcile_journal_hash=""
reconcile_request=""
reconcile_evidence=""
reconcile_stopped=0
root_uid=0
serving_root="$FIXTURE_ROOT"
releases_root="$FIXTURE_ROOT"
journal_file="$FIXTURE_ROOT/journal.json"
current_link="$FIXTURE_ROOT/current"
config_file="$FIXTURE_ROOT/config.json"
state_database="$FIXTURE_ROOT/state.sqlite"
session_witness_record=""
session_witness=""
session_proof=original-pre-cutover
node_bin="$FIXTURE_NODE"
proof() { "$node_bin" "$FIXTURE_HELPER" proof "$@"; }
read_pointer() { readlink "$1"; }
fail() { printf '%s\n' "$*" >&2; return 1; }
migration_check_existing_guard() { :; }
assert_protected_identity() { :; }
assert_policy() { :; }
assert_exclusive_owner() { :; }
capture_generation() { service_pid=123; service_generation=456; }
recheck_generation() { :; }
verify_convergence() {
  # Convergence has used 590 seconds of the existing 600-second deadline.
  clock_ms=590000; SECONDS=590
  verified_pid=123; verified_generation=456; verified_instance=fixture-instance
}
run_marker_rpc() { "$node_bin" "$FIXTURE_HELPER" rpc "$2" "$3" "$4" "$clock_ms"; }
run_gateway() { printf '{"pid":123,"processInstanceId":"fixture-instance"}'; }
bounded() {
  local budget="$1" milliseconds
  shift
  [[ "$1" == sleep && "$#" == 2 ]] || return 90
  milliseconds="$("$node_bin" "$FIXTURE_HELPER" pause "$clock_ms" "$budget" "$2")" || return 1
  clock_ms=$((clock_ms + milliseconds)); SECONDS=$((clock_ms / 1000))
}
` + functions + String.raw`
if recover_journal; then exit 0; else exit "$?"; fi
`;
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C", LC_ALL: "C",
      OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
      FIXTURE_ROOT: root, FIXTURE_HELPER: helper, FIXTURE_NODE: process.execPath,
      FIXTURE_TERMINAL_AT_MS: String(terminalAtMs), FIXTURE_OBSERVATION_FAILURE: JSON.stringify(failure),
      FIXTURE_ADMISSION_READY_AT_MS: String(admissionReadyAtMs) },
  });
  assert.ifError(result.error);
  assert.ok(existsSync(events), result.stderr || result.stdout);
  const rows = readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { result, rows, journal, original };
}

test("marker completion in the final window is observed before the original deadline", (t) => {
  const { result, rows, journal } = deadlineRecovery(t, 597_000);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MARKER_VERIFIED .*observation=agent.wait/);
  assert.match(result.stdout, /RECOVERED phase=ROLLBACK_FAILED/);
  assert.equal(existsSync(journal), false);
  assert.equal(rows.filter((row) => row.kind === "agent").length, 1);
  const observations = rows.filter((row) => row.kind === "agent.wait");
  assert.ok(observations.some((row) => row.atMs >= 597_000 && row.atMs < 600_000));
  assert.ok(observations.every((row) => row.atMs < 600_000 && row.nativeWait === 0));
});

test("pending marker expires without a tight polling loop or retiring recovery evidence", (t) => {
  const { result, rows, journal, original } = deadlineRecovery(t, Infinity);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /stage=marker.wait-budget/);
  assert.doesNotMatch(result.stdout, /MARKER_VERIFIED|RECOVERED/);
  assert.equal(readFileSync(journal, "utf8"), original);
  assert.equal(rows.filter((row) => row.kind === "agent").length, 1);
  assert.equal(rows.filter((row) => row.kind === "recovery-finish").length, 0);
  const observations = rows.filter((row) => row.kind === "agent.wait");
  assert.ok(observations.length > 1 && observations.length <= 20);
  assert.ok(observations.every((row) => row.atMs < 600_000 && row.clientBudget <= (600 - Math.floor(row.atMs / 1000)) * 1000));
  const pauses = rows.filter((row) => row.kind === "pause");
  assert.ok(pauses.every((row) => row.ms >= 500 && row.ms <= 10_000));
  assert.equal(pauses.at(-1).atMs + pauses.at(-1).ms, 600_000);
});

for (const failure of [
  { exit: 75, output: "RETRYABLE_OBSERVATION_TRANSPORT", retry: true },
  { exit: 75, output: "unclassified native failure", retry: false },
  { exit: 1, output: "RETRYABLE_OBSERVATION_TRANSPORT", retry: false },
]) test(`observation failure ${failure.exit}/${failure.retry ? "typed" : "unclassified"} retains the absolute recovery deadline`, t => {
  const { result, rows, journal, original } = deadlineRecovery(t, Infinity, failure);
  assert.notEqual(result.status, 0); assert.equal(readFileSync(journal, "utf8"), original);
  assert.doesNotMatch(result.stdout, /MARKER_VERIFIED|RECOVERED/);
  assert.equal(rows.filter(row => row.kind === "agent").length, 1);
  assert.equal(rows.filter(row => row.kind === "recovery-finish").length, 0);
  const observations = rows.filter(row => row.kind === "agent.wait");
  assert.ok(observations.every(row => row.atMs < 600_000 && row.nativeWait === 0 && row.clientBudget <= (600 - Math.floor(row.atMs / 1000)) * 1000));
  if (failure.retry) {
    assert.match(result.stderr, /MARKER_OBSERVATION_RETRY/);
    assert.match(result.stderr, /stage=marker.wait-budget/);
    assert.ok(observations.length > 1 && observations.length <= 20);
    const pauses = rows.filter(row => row.kind === "pause");
    assert.ok(pauses.every(row => row.ms >= 500 && row.ms <= 10_000));
    assert.equal(pauses.at(-1).atMs + pauses.at(-1).ms, 600_000);
  } else {
    assert.equal(observations.length, 1);
    assert.doesNotMatch(result.stderr, /MARKER_OBSERVATION_RETRY/);
  }
});

test("startup admission pending is retried with the identical payload before any dispatch", (t) => {
  const { result, rows, journal } = deadlineRecovery(t, 597_000, null, 596_000);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /MARKER_ADMISSION_RETRY same-payload=required/);
  assert.match(result.stdout, /MARKER_VERIFIED .*observation=agent.wait/);
  assert.equal(existsSync(journal), false);
  const dispatches = rows.filter((row) => row.kind === "agent");
  assert.equal(dispatches.length, 3);
  assert.equal(new Set(dispatches.map((row) => row.idempotencyKey)).size, 1);
  assert.ok(dispatches.every((row) => row.atMs < 600_000));
  const pauses = rows.filter((row) => row.kind === "pause" && row.atMs < 596_000);
  assert.equal(pauses.length, 2);
  assert.ok(pauses.every((row) => row.ms === 3000));
});

test("startup admission still pending at the deadline fails without retiring recovery evidence", (t) => {
  const { result, rows, journal, original } = deadlineRecovery(t, Infinity, null, Infinity);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /stage=marker.admission-budget/);
  assert.doesNotMatch(result.stdout, /MARKER_VERIFIED|RECOVERED/);
  assert.equal(readFileSync(journal, "utf8"), original);
  assert.equal(existsSync(join(dirname(journal), "accepted.json")), false);
  assert.equal(rows.filter((row) => row.kind === "agent.wait").length, 0);
  const dispatches = rows.filter((row) => row.kind === "agent");
  assert.ok(dispatches.length >= 2 && dispatches.length <= 5);
  assert.ok(dispatches.every((row) => row.atMs < 600_000));
});

function successorActivation(t, { stopSeconds = 94, listenerAt = 60, rpcAt = listenerAt,
  fault = "", mode = "deploy", retrySeconds = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "team-successor-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = readFileSync(ownerPath, "utf8");
  const functions = ["assert_single_listener", "capture_service_generation", "capture_generation",
    "recheck_generation", "assert_protected_identity", "assert_policy", "verification_failure",
    "verification_step", "verify_convergence", "wait_for_live", "bind_successor_generation",
    "profile_admit", "profile_finish", "verify_deployed_candidate", "prepare_rollback_suspension",
    "rollback_activation", "activate_release"].map(name => ownerFunction(source, name)).join("\n");
  // Run the actual activation and rollback owners. Only external effects, marker
  // completion, and unrelated pre-start admission are synthetic. No wall sleeps.
  const script = String.raw`
set -Eeuo pipefail
unset SECONDS
SECONDS=1000
verification_budget=600
verification_deadline=0
verification_owned_pid=""
verification_owned_generation=""
verification_owned_scope=""
mode="$FIXTURE_MODE"
serving_root="$FIXTURE_ROOT"
previous_release="$serving_root/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
candidate_release="$serving_root/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
[[ "$mode" != runtime ]] || candidate_release="$previous_release"
current_link="$serving_root/current"
previous_link="$serving_root/previous"
journal_file="$serving_root/journal.json"
previous_info='{"buildId":"fixture"}'
candidate_info="$previous_info"
node_bin="$FIXTURE_NODE"
ss_bin=listener_snapshot
gateway_port=18789
proc_root="$serving_root/proc"
root_uid=0
runtime_uid=1000
config_file="$serving_root/config"
state_database="$serving_root/state"
protected_identity=identity
policy_identity=policy
reconcile_evidence=""
session_witness=""
session_witness_record=""
gateway_runtime_snapshot=""
runtime_target=""
capture_startup_profile=0
arm_steady_profile=0
profile_operation=""
profile_finished=0
interrupt_after_drain=1
allow_cpu_degraded=0
rollback_armed=0
predecessor_stopped=0
restart_failed=0
held_suspension=""
suspension_expiry=expiry
suspension_state=DRAINING
verified_pid=""
verified_generation=""
active=predecessor
successor_started=-1
record() { printf '%s %s\n' "$SECONDS" "$*" >>"$serving_root/events"; }
fail() { printf 'openclaw-release-deploy: %s\n' "$*" >&2; return 1; }
sleep() { record "sleep $1"; SECONDS=$((SECONDS + $1)); }
read_service() {
  [[ "$active" != stopped ]] || return 1
  service_pid=111
  [[ "$active" != successor ]] || service_pid=222
  if [[ "$active" == successor && "$FIXTURE_FAULT" == generation && $SECONDS -ge $((successor_started + 20)) ]]; then service_pid=333; fi
}
process_generation() { printf '%s0' "$1"; }
assert_exclusive_owner() { :; }
listener_snapshot() {
  record "listener $active"
  if [[ "$active" == successor ]]; then
    ((SECONDS - successor_started >= FIXTURE_LISTENER_AT)) || return 0
    [[ "$FIXTURE_FAULT" != foreign ]] || { printf 'LISTEN 0 511 127.0.0.1:18789 0.0.0.0:* users:(("node",pid=999,fd=1))\n'; return 0; }
  fi
  printf 'LISTEN 0 511 127.0.0.1:18789 0.0.0.0:* users:(("node",pid=%s,fd=1))\n' "$service_pid"
}
stopped_system_owners() {
  record stopped-proof
  if [[ "$active" == successor && "$FIXTURE_FAULT" == exit-at-budget && $SECONDS -ge $((successor_started + 600)) ]]; then active=stopped; fi
  [[ "$active" == stopped ]] || { fail 'stopped Gateway proof requires system/user owners without queued start/control jobs'; return 1; }
}
predecessor_is_stopped() { stopped_system_owners; }
system_systemctl() {
  record "systemctl $1"
  case "$1" in
    stop) SECONDS=$((SECONDS + FIXTURE_STOP_SECONDS)); active=stopped ;;
    start|restart)
      if [[ "$active" == predecessor ]]; then SECONDS=$((SECONDS + FIXTURE_STOP_SECONDS)); fi
      if ((successor_started < 0)); then
        active=successor; successor_started=$SECONDS; record successor-start
      else active=rollback; record rollback-start; fi ;;
    daemon-reload) : ;;
    *) return 90 ;;
  esac
}
proof() {
  case "$1" in
    fingerprint)
      if [[ "$active" == successor && "$FIXTURE_FAULT" == identity ]]; then printf drift; else printf identity; fi ;;
    policy)
      if [[ "$active" == successor && "$FIXTURE_FAULT" == policy ]]; then printf drift; else printf policy; fi ;;
    candidate-config-accept) record config-refused; return 1 ;;
    compatibility)
      if ((rollback_armed == 0)) && ((successor_started >= 0)); then record rollback-compatibility; else record activation-compatibility; fi ;;
    journal-create) printf '{"phase":"A_PREPARED","originalWitness":"fixture"}' >"$journal_file" ;;
    journal-read) cat "$journal_file" ;;
    journal-phase) record "phase $3"; printf '{"phase":"%s","originalWitness":"fixture"}' "$3" >"$journal_file" ;;
    journal-field)
      case "$3" in
        predecessor.sha) basename "$previous_release" ;;
        candidate.sha) basename "$candidate_release" ;;
        topology) printf system ;;
        process.pid) printf 111 ;;
        process.generation) printf 1110 ;;
        *) return 90 ;;
      esac ;;
    session-preservation-witness) printf witness ;;
    unlink-exact) record journal-retired; rm "$journal_file" ;;
    migration-status) printf none ;;
    probes) printf READY ;;
    channels) printf CHANNELS_OK ;;
    validate-release|gateway-runtime) : ;;
    *) return 90 ;;
  esac
}
proof_json() { [[ "$1" == gateway-status ]]; }
run_gateway() {
  if [[ " $* " == *" system.info "* ]]; then
    record "rpc $active"
    if [[ "$active" == successor ]]; then ((SECONDS - successor_started >= FIXTURE_RPC_AT)) || return 1; fi
    printf '{"pid":%s,"processInstanceId":"fixture-instance"}' "$service_pid"
  fi
}
read_probe() { probe_body='{}'; probe_status=200; }
verify_marker() { record marker; recheck_generation "$2" "$verified_pid" "$verified_generation"; }
assert_scheduler_owner() { :; }
assert_frozen_predecessor() { :; }
assert_stop_start_contract() { :; }
read_process_instance() { printf fixture-instance; }
prepare_suspension() { record suspension; held_suspension=lease; }
check_suspension() { :; }
arm_suspension_handoff() { :; }
system_unit_state() { printf enabled; }
system_state() { printf active; }
user_unit_state() { printf disabled; }
user_state() { printf inactive; }
atomic_pointer() { record pointer; }
load_journal_witness() { session_witness_record="$(cat "$journal_file")"; }
load_gateway_runtime() { :; }
restore_pointer_topology() { record restore-pointers; }
record_failed() { record candidate-failed; }
verified_markers() { record verified-marker; }
cleanup_releases() { :; }
realpath() { printf '%s' "$previous_release"; }
` + functions + String.raw`
if activate_release system; then exit 0; else activation_exit=$?; fi
rollback_activation "$activation_exit" || exit "$?"
`;
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8", timeout: 90_000, maxBuffer: 512 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C", LC_ALL: "C",
      OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
      FIXTURE_ROOT: root, FIXTURE_NODE: process.execPath, FIXTURE_MODE: mode,
      OPENCLAW_TEAM_RETRY_SECONDS: String(retrySeconds),
      FIXTURE_STOP_SECONDS: String(stopSeconds), FIXTURE_LISTENER_AT: String(listenerAt),
      FIXTURE_RPC_AT: String(rpcAt), FIXTURE_FAULT: fault },
  });
  assert.ifError(result.error);
  const rows = readFileSync(join(root, "events"), "utf8").trim().split("\n").map(line => {
    const [at, ...event] = line.split(" "); return { at: Number(at), event: event.join(" ") };
  });
  const journal = existsSync(join(root, "journal.json")) ? JSON.parse(readFileSync(join(root, "journal.json"))) : null;
  const startIndex = rows.findIndex(row => row.event === "successor-start");
  return { result, rows, journal, started: rows[startIndex]?.at, afterStart: rows.slice(startIndex + 1) };
}

for (const mode of ["runtime", "deploy"]) test(`successor convergence: ${mode} waits for a late listener and RPC after a 94-second stop`, t => {
  const rpcAt = mode === "runtime" ? 90 : 60;
  const { result, rows, journal, started, afterStart } = successorActivation(t, { mode, rpcAt });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SUCCESS /);
  assert.match(result.stderr, /stage=convergence.generation/);
  if (rpcAt > 60) assert.match(result.stderr, /stage=convergence.process-rpc/);
  assert.equal(started, 1094);
  assert.equal(rows.find(row => row.event === "marker").at - started, rpcAt);
  assert.equal(rows.some(row => row.event === "rollback-compatibility"), false);
  assert.equal(afterStart.some(row => row.event === "stopped-proof"), false);
  assert.equal(journal, null);
});

for (const stopSeconds of [0, 94]) test(`successor convergence: ${stopSeconds}-second predecessor stop leaves the full 600-second window`, t => {
  const { result, rows, journal, started } = successorActivation(t, { stopSeconds, listenerAt: 598, retrySeconds: 13 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SUCCESS /);
  assert.equal(rows.find(row => row.event === "marker").at - started, 600 - 2);
  assert.equal(journal, null);
});

for (const fault of ["", "exit-at-budget"]) test(`successor convergence: missing listener exhausts the budget before one rollback attempt (${fault || "still running"})`, t => {
  const { result, rows, journal, started, afterStart } = successorActivation(t, { listenerAt: 9999, fault, retrySeconds: 17 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stage=wait-for-live.budget/);
  assert.doesNotMatch(result.stdout, /SUCCESS /);
  const rollback = rows.filter(row => row.event === "rollback-compatibility");
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0].at - started, 600);
  assert.ok(afterStart.filter(row => row.event === "stopped-proof").every(row => row.at - started >= 600));
  assert.equal(rows.filter(row => row.event === "systemctl restart").length, fault ? 1 : 0);
  if (fault) {
    assert.match(result.stderr, /ROLLED_BACK /);
    assert.equal(journal, null);
  } else {
    assert.equal(journal.phase, "ROLLBACK_FAILED");
    assert.equal(journal.originalWitness, "fixture");
    assert.equal(rows.some(row => row.event === "restore-pointers"), false);
  }
});

for (const fault of ["generation", "foreign", "policy", "identity"]) test(`successor convergence: ${fault} drift never gains verification or rollback authority`, t => {
  const { result, rows, journal } = successorActivation(t, { listenerAt: fault === "generation" ? 60 : 0, fault, retrySeconds: 20 });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /SUCCESS /);
  assert.match(result.stderr, new RegExp({ generation: "started recovery Gateway generation changed",
    foreign: "Gateway does not own one exact loopback listener", policy: "stage=convergence.policy",
    identity: "stage=convergence.protected-state" }[fault]));
  assert.equal(rows.some(row => row.event === "marker" || row.event === "restore-pointers"), false);
  assert.equal(journal.phase, "ROLLBACK_FAILED");
  assert.equal(journal.originalWitness, "fixture");
});
