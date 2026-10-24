import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ownerPath = process.env.MARKER_DEADLINE_TEST_OWNER ??
  join(dirname(fileURLToPath(import.meta.url)), "openclaw-release-deploy");

function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "team-marker-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runShell(root, script, env, timeout, maxBuffer = 256 * 1024) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8", timeout, maxBuffer,
    env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C", LC_ALL: "C",
      OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
      FIXTURE_ROOT: root, FIXTURE_NODE: process.execPath, ...env },
  });
  assert.ifError(result.error);
  return result;
}

// Both flows start with the same disabled optional features and private paths.
const shellSetup = String.raw`
set -Eeuo pipefail
unset SECONDS
verification_budget=600
root_uid=0
serving_root="$FIXTURE_ROOT"
releases_root="$serving_root"
journal_file="$serving_root/journal.json"
current_link="$serving_root/current"
node_bin="$FIXTURE_NODE"
previous_release="$serving_root/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
candidate_release="$serving_root/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
previous_info='{"buildId":"fixture"}'
proc_root="$serving_root/proc"
fixture_defaults() {
  local value="$1" variable; shift
  for variable; do printf -v "$variable" '%s' "$value"; done
}
fixture_defaults '' reconcile_evidence session_witness session_witness_record \
  gateway_runtime_snapshot native_update_root profile_operation
fixture_defaults 0 allow_cpu_degraded arm_steady_profile profile_finished restart_failed
run_gateway_node() { "$node_bin" "$@"; }
proof_json() { [[ "$1" == gateway-status ]]; }
assert_scheduler_owner() { :; }
`;

// Exercise the actual shell control flow with synthetic external effects and time.
// This does not prove GNU timeout, process capabilities, or live Gateway behavior.
function ownerFunction(source, name) {
  const declarations = [...source.matchAll(/^([a-zA-Z_][a-zA-Z_0-9]*)\(\) \{/gm)];
  const index = declarations.findIndex((match) => match[1] === name);
  assert.notEqual(index, -1, `missing owner function ${name}`);
  return source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length);
}

// Journal retirement/retention is exercised through runOwner in release.test.mjs.
// Here the real acceptance owner gets a virtual clock and synthetic transports.
function deadlineMarker(t, options) {
  const { terminalAtMs = 590_000, observationFailure = null, admissionReadyAtMs = 0 } = options;
  const root = fixtureRoot(t);
  const events = join(root, "events.jsonl"), sdk = join(root, "dist/plugin-sdk");
  writeFileSync(events, "");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
    // Closed native SDK examples; parsing itself belongs to the public SDK.
    writeFileSync(join(sdk, "model-ref-parse.js"), `
export function splitTrailingAuthProfile(raw) {
  const routes = {
    "fixture/exact-model":"fixture/exact-model", "fixture/fallback":"fixture/fallback",
    "fixture/exact-model@work":"fixture/exact-model", "fixture/fallback@work":"fixture/fallback",
    "fixture/fallback@20251001":"fixture/fallback@20251001"
  };
  if (!Object.hasOwn(routes, raw)) throw Error("unexpected synthetic model route");
  return { model: routes[raw] };
}
`);
  const helper = join(root, "helper.mjs");
  writeFileSync(helper, String.raw`
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root=process.env.FIXTURE_ROOT, cfg=JSON.parse(process.env.FIXTURE_CONFIG), [kind,...args]=process.argv.slice(2);
const emit=value=>process.stdout.write(JSON.stringify(value));
const record=value=>appendFileSync(join(root,"events.jsonl"),JSON.stringify(value)+"\n");
const eventLoop=atMs=>{
  const delayed=atMs<(cfg.loopReadyAtMs??0),busy=Boolean(cfg.busyCpu);
  return {degraded:delayed||busy,reasons:[...(delayed?["event_loop_delay"]:[]),...(busy?["cpu","event_loop_utilization"]:[])],
    intervalMs:1000,delayP99Ms:delayed?1000:busy?50:0,delayMaxMs:delayed?1000:busy?50:0,
    utilization:busy?1:0.1,cpuCoreRatio:busy?1.2:0.1,degradedSinceMs:delayed||busy?0:null};
};
if(kind==="proof") {
  switch(args[0]) {
    case "validate-release": emit({buildId:"fixture"}); break;
    case "approvals": process.stdout.write("0"); break;
    case "session-preservation-verify": case "compatibility": case "recovery-check": case "gateway-runtime": break;
    default: throw Error("unexpected proof operation "+args[0]);
  }
} else if(kind==="rpc") {
  const [method,raw,clientBudget,clock]=args,params=JSON.parse(raw),atMs=Number(clock);
  record({kind:method,atMs,clientBudget:Number(clientBudget),nativeWait:params.timeoutMs,idempotencyKey:params.idempotencyKey});
  if(method==="system.info") {
    if(atMs<(cfg.rpcReadyAtMs??0)) {process.stdout.write("RETRYABLE_READINESS_TRANSPORT");process.exit(78);}
    emit({pid:123,processInstanceId:cfg.processDrift?"wrong-instance":"fixture-instance"});
  } else if(method==="agent") {
    if(atMs<(cfg.admissionReadyAtMs??0)) {process.stdout.write("RETRYABLE_ADMISSION_PENDING");process.exit(76);}
    const dispatchFailure=cfg.dispatchFailure, accepted=join(root,"accepted.json");
    let prior; try {prior=readFileSync(accepted,"utf8");} catch(error) {if(error.code!=="ENOENT")throw error;}
    if(prior) assert.equal(prior,raw,"retry must preserve the exact native request");
    else {writeFileSync(accepted,raw);record({kind:"native-run",runId:params.idempotencyKey});}
    if(dispatchFailure&&(!dispatchFailure.once||!prior)) {process.stdout.write(dispatchFailure.output);process.exit(dispatchFailure.exit);}
    emit(prior?{status:"in_flight",runId:params.idempotencyKey}:{status:"accepted",runId:params.idempotencyKey,agentId:params.agentId,sessionKey:params.sessionKey});
  } else {
    const accepted=JSON.parse(readFileSync(join(root,"accepted.json"),"utf8"));
    assert.equal(method,"agent.wait"); assert.equal(params.runId,accepted.idempotencyKey);
    const failure=cfg.observationFailure;
    if(failure) {process.stdout.write(failure.output);process.exit(failure.exit);}
    if(atMs<(cfg.terminalAtMs??0)) emit({runId:params.runId,status:"timeout"});
    else {
      emit({runId:params.runId,status:"ok",endedAt:atMs,stopReason:"stop",
        terminalReply:{disposition:"visible",text:accepted.message.split(": ").at(-1)},
        terminalReceipt:{runId:params.runId,sessionId:accepted.sessionId,turnId:"fixture-turn",
          requested:{provider:"fixture",model:(cfg.requestedModel??"exact-model")},
          terminalDisposition:"visible",effective:{provider:"fixture",model:(cfg.effectiveModel??"exact-model")}}});
    }
  }
} else if(kind==="probe") {
  const [endpoint,clock]=args,atMs=Number(clock);
  const respond=(status,body)=>process.stdout.write(status+" "+JSON.stringify(body));
  if(atMs<(cfg.probeReadyAtMs??0))process.exit(28);
  if(endpoint==="startupz") {
    const starting=atMs<(cfg.startupReadyAtMs??0)||cfg.otherAgentPending;
    respond(starting?503:200,starting
      ?{ok:false,status:"starting",pendingReason:cfg.otherAgentPending?"agent-database-inspection":"startup-sidecars",uptimeMs:atMs}
      :{ok:true,status:"started",uptimeMs:atMs});
  }
  else {
    const pending=atMs<(cfg.markerReadyAtMs??0),code=cfg.refusalCode;
    const agentDatabases=[...(cfg.otherAgentPending?[{agentId:"other-agent",code:"agent-database-inspection-pending"}]:[]),
      ...(pending||code?[{agentId:JSON.parse(process.env.OPENCLAW_TEAM_OPERATOR_PROFILE).modelAgent,code:code||"agent-database-inspection-pending"}]:[])];
    const ready=atMs>=(cfg.readyzReadyAtMs??0);
    respond(ready?200:503,{ready,failing:ready?[]:["discord"],uptimeMs:atMs,eventLoop:eventLoop(atMs),...(agentDatabases.length?{agentDatabases}:{})});
  }
} else if(kind==="pause") {
  const [at,budget,seconds]=args,ms=Number(seconds)*1000;
  assert.ok(Number.isInteger(ms)&&ms>0); assert.ok(ms<=Number(budget)*1000);
  record({kind,atMs:Number(at),ms,budgetMs:Number(budget)*1000});
  process.stdout.write(String(ms));
} else throw Error("unexpected helper operation "+kind);
`);
  const source = readFileSync(ownerPath, "utf8");
  const functions = ["verification_failure", "verification_step", "wait_for_marker_readiness", "verify_marker",
    "wait_for_live"].map((name) => ownerFunction(source, name)).join("\n");
  const script = shellSetup + String.raw`
SECONDS=0
clock_ms=0
state_database="$FIXTURE_ROOT/state.sqlite"
session_witness='{}'
policy_identity="$FIXTURE_POLICY"
proof() {
  if [[ "$1" == marker-readiness ]]; then "$node_bin" "$FIXTURE_LIBRARY" "$@"
  else "$node_bin" "$FIXTURE_HELPER" proof "$@"; fi
}
fail() { printf '%s\n' "$*" >&2; return 1; }
assert_protected_identity() { :; }
assert_policy() { :; }
assert_exclusive_owner() { :; }
recheck_generation() { :; }
verify_convergence() {
  # Convergence has used 590 seconds of the existing 600-second deadline.
  if ((clock_ms == 0)); then clock_ms="$FIXTURE_CONVERGENCE_AT_MS"; SECONDS=$((clock_ms / 1000)); fi
  verified_pid=123; verified_generation=456; verified_instance=fixture-instance
}
run_marker_rpc() { "$node_bin" "$FIXTURE_HELPER" rpc "$2" "$3" "$4" "$clock_ms"; }
read_probe() {
  local body
  body="$("$node_bin" "$FIXTURE_HELPER" probe "$1" "$clock_ms")" || return "$?"
  read -r probe_status probe_body <<< "$body"
}
run_gateway() { printf '{"pid":123,"processInstanceId":"fixture-instance"}'; }
sleep() { bounded "$((verification_deadline - SECONDS))" sleep "$1"; }
bounded() {
  local budget="$1" milliseconds
  shift
  [[ "$1" == sleep && "$#" == 2 ]] || return 90
  milliseconds="$("$node_bin" "$FIXTURE_HELPER" pause "$clock_ms" "$budget" "$2")" || return 1
  clock_ms=$((clock_ms + milliseconds)); SECONDS=$((clock_ms / 1000))
}
` + functions + String.raw`
if wait_for_live "$serving_root" '{"buildId":"fixture"}' system; then exit 0; else exit "$?"; fi
`;
  const result = runShell(root, script, {
    FIXTURE_HELPER: helper, FIXTURE_LIBRARY: join(dirname(ownerPath), "release-lib.mjs"),
    FIXTURE_POLICY: JSON.stringify({ model: options.policyModel ?? "fixture/exact-model", fallbacks: options.fallbacks ?? [] }),
    FIXTURE_CONVERGENCE_AT_MS: String(options.convergenceAtMs ?? 590_000),
    FIXTURE_CONFIG: JSON.stringify({ ...options, terminalAtMs, observationFailure, admissionReadyAtMs },
      (_key, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value),
  }, 20_000);
  const rows = readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result, rows, root };
}

function markerCase(name, options, check = () => {}, failure = false) {
  test(name, t => {
    const state = deadlineMarker(t, options);
    const { result, rows } = state;
    const events = kind => rows.filter(row => row.kind === kind);
    const dispatches = events("agent"), observations = events("agent.wait"), pauses = events("pause");
    if (failure) {
      assert.notEqual(result.status, 0, result.stdout);
      assert.doesNotMatch(result.stdout, /MARKER_VERIFIED/);
      if (failure instanceof RegExp) { assert.match(result.stderr, failure); }
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /MARKER_VERIFIED .*observation=agent.wait/);
    }
    assert.ok(dispatches.every(row => row.atMs < 600_000));
    assert.ok(new Set(dispatches.map(row => row.idempotencyKey)).size <= 1);
    assert.ok(events("native-run").length <= 1);
    assert.ok(observations.every(row => row.atMs < 600_000 && row.nativeWait === 0 &&
      row.clientBudget <= (600 - Math.floor(row.atMs / 1000)) * 1000));
    check({ ...state, events, dispatches, observations, pauses });
  });
}

function assertDeadline(pauses) {
  assert.equal(pauses.at(-1).atMs + pauses.at(-1).ms, 600_000);
}

markerCase("marker completion is observed in the final window", { terminalAtMs: 597_000 },
  ({ dispatches, observations }) => {
    assert.equal(dispatches.length, 1);
    assert.ok(observations.some(row => row.atMs >= 597_000));
  });

for (const [label, observationFailure, retry] of [
  ["pending marker", null, null],
  ["typed transport failure", { exit: 75, output: "RETRYABLE_OBSERVATION_TRANSPORT" }, true],
  ["unclassified native failure", { exit: 75, output: "unclassified native failure" }, false],
  ["wrong transport exit", { exit: 1, output: "RETRYABLE_OBSERVATION_TRANSPORT" }, false],
]) {
  markerCase(`${label} preserves the absolute observation deadline`,
    { terminalAtMs: Infinity, observationFailure }, ({ result, dispatches, observations, pauses }) => {
      assert.equal(dispatches.length, 1);
      if (retry !== false) {
        assert.match(result.stderr, /stage=marker.wait-budget/);
        assert.ok(observations.length > 1 && observations.length <= 20);
        assert.ok(pauses.every(row => row.ms >= 500 && row.ms <= 10_000));
        assertDeadline(pauses);
      } else { assert.equal(observations.length, 1); }
      if (retry) { assert.match(result.stderr, /MARKER_OBSERVATION_RETRY/); }
      else { assert.doesNotMatch(result.stderr, /MARKER_OBSERVATION_RETRY/); }
    }, true);
}

markerCase("pending admission retries the identical request before dispatch",
  { terminalAtMs: 597_000, admissionReadyAtMs: 596_000 }, ({ result, dispatches, pauses }) => {
    assert.match(result.stderr, /MARKER_ADMISSION_RETRY same-payload=required/);
    assert.equal(dispatches.length, 3);
    const admissionPauses = pauses.filter(row => row.atMs < 596_000);
    assert.equal(admissionPauses.length, 2);
    assert.ok(admissionPauses.every(row => row.ms === 3000));
  });
markerCase("pending admission expires without dispatch",
  { terminalAtMs: Infinity, admissionReadyAtMs: Infinity }, ({ root, dispatches, observations }) => {
    assert.equal(existsSync(join(root, "accepted.json")), false);
    assert.equal(observations.length, 0);
    assert.ok(dispatches.length >= 2 && dispatches.length <= 5);
  }, /stage=marker.admission-budget/);

// Full convergence load policy is covered by release.test.mjs; these cases own
// the later marker-readiness gate and its remaining absolute budget.
for (const [label, options, earliest, exact = false] of [
  ["critical startup and responsive probes", { startupReadyAtMs: 591_000, markerReadyAtMs: 592_000,
    probeReadyAtMs: 593_000, rpcReadyAtMs: 596_000, loopReadyAtMs: 594_000 }, 596_000],
  ["native readiness after convergence", { readyzReadyAtMs: 596_000 }, 596_000, true],
  ["responsive sustained CPU load", { busyCpu: true }, 590_000],
  ["event-loop delay settles", { busyCpu: true, loopReadyAtMs: 592_000 }, 592_000],
  ["other agent inspects", { otherAgentPending: true }, 590_000],
  ["model agent also waits", { otherAgentPending: true, markerReadyAtMs: 593_000 }, 593_000],
]) {
  markerCase(`marker waits for ${label} without a CPU waiver`, { ...options, terminalAtMs: earliest },
    ({ result, dispatches }) => {
      assert.equal(dispatches.length, 1);
      assert.ok(exact ? dispatches[0].atMs === earliest : dispatches[0].atMs >= earliest);
      assert.doesNotMatch(result.stdout, /CPU_DEGRADED_OPERATOR_WAIVED/);
    });
}

markerCase("persistent native not-ready exhausts the original deadline",
  { terminalAtMs: Infinity, readyzReadyAtMs: 601_000 }, ({ dispatches, pauses }) => {
    assert.equal(dispatches.length, 0); assertDeadline(pauses);
  }, /stage=marker.readiness-budget/);
for (const [label, options] of [
  ["unclassified dispatch", { dispatchFailure: { exit: 77, output: "not a typed timeout" } }],
  ["corrupt agent store", { refusalCode: "agent-database-inspection-failed" }],
  ["changed process instance", { processDrift: true }],
  ["unsettled readiness", { markerReadyAtMs: Infinity }],
  ["persistent dispatch timeout", { convergenceAtMs: 596_000, dispatchFailure: { exit: 77, output: "RETRYABLE_DISPATCH_TIMEOUT" } }],
]) {
  markerCase(`${label} fails without renewing the deadline`, { ...options, terminalAtMs: Infinity }, undefined, true);
}

markerCase("dispatch reconciles one native run after fresh readiness",
  { terminalAtMs: 598_000, markerReadyAtMs: 593_000,
    dispatchFailure: { exit: 77, output: "RETRYABLE_DISPATCH_TIMEOUT", once: true } },
  ({ rows, events, dispatches }) => {
    assert.equal(events("native-run").length, 1);
    assert.equal(dispatches.length, 2);
    assert.ok(rows.slice(rows.indexOf(dispatches[0]) + 1, rows.indexOf(dispatches[1])).some(row => row.kind === "system.info"));
  });

// Full-entrypoint transport refusals and dispatch replay live in release.test.mjs.
for (const [method, error, exit, output] of [
  ["system.info", { name: "GatewayTransportError", kind: "timeout" }, 78, "RETRYABLE_READINESS_TRANSPORT"],
  ["agent", { name: "GatewayClientRequestError", code: "UNAUTHORIZED" }, 1, ""],
  ["agent", { name: "GatewayClientRequestError", code: "UNAVAILABLE", details: { code: "agent-database-inspection-failed" } }, 1, ""],
]) {
test(`native ${method} classifies ${error.code ?? error.kind}`, t => {
  const root = fixtureRoot(t);
  mkdirSync(join(root, "dist/plugin-sdk"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "dist/plugin-sdk/gateway-runtime.js"), `
export function isGatewayTransportError(error) { return error.name === "GatewayTransportError"; }
export async function callGatewayFromCli() { throw Object.assign(new Error("synthetic failure"), JSON.parse(process.env.FIXTURE_ERROR)); }
`);
  const script = `set -Eeuo pipefail
run_gateway_node() { "$FIXTURE_NODE" "$@"; }
${ownerFunction(readFileSync(ownerPath, "utf8"), "run_marker_rpc")}
run_marker_rpc "$FIXTURE_ROOT" "$FIXTURE_METHOD" '{}' 10000
`;
  const result = runShell(root, script, { FIXTURE_METHOD: method, FIXTURE_ERROR: JSON.stringify(error) }, 5000);
  assert.equal(result.status, exit, result.stderr);
  assert.equal(result.stdout, output);
});
}

function successorActivation(t, { stopSeconds = 94, listenerAt = 60, rpcAt = listenerAt,
  fault = "", mode = "deploy", retrySeconds = 2, pointers = false, suspensionState = "DRAINING" } = {}) {
  const root = fixtureRoot(t);
  if (pointers) {
    for (const sha of ["a".repeat(40), "b".repeat(40), "c".repeat(40)]) {
      mkdirSync(join(root, sha));
    }
    symlinkSync(join(root, "a".repeat(40)), join(root, "current"));
    symlinkSync(join(root, "c".repeat(40)), join(root, "previous"));
  }
  const source = readFileSync(ownerPath, "utf8");
  const functions = ["assert_single_listener", "capture_service_generation", "capture_generation",
    "recheck_generation", "read_pointer", "check_suspension", "assert_protected_identity", "assert_policy", "verification_failure",
    "verification_step", "verify_convergence", "wait_for_live", "bind_successor_generation",
    "profile_admit", "profile_finish", "verify_deployed_candidate", "prepare_rollback_suspension",
    "rollback_activation", "activate_release"].map(name => ownerFunction(source, name)).join("\n");
  // Run the actual activation and rollback owners. Only external effects, marker
  // completion, and unrelated pre-start admission are synthetic. No wall sleeps.
  const script = shellSetup + String.raw`
SECONDS=1000
fixture_defaults '' verification_owned_pid verification_owned_generation verification_owned_scope \
  runtime_target held_suspension suspension_blockers verified_pid verified_generation
fixture_defaults 0 verification_deadline capture_startup_profile rollback_armed \
  predecessor_stopped suspension_cleanup_only
mode="$FIXTURE_MODE"
[[ "$mode" != runtime ]] || candidate_release="$previous_release"
previous_link="$serving_root/previous"
candidate_info="$previous_info"
ss_bin=listener_snapshot
gateway_port=18789
runtime_uid=1000
config_file="$serving_root/config"
state_database="$serving_root/state"
protected_identity=identity
policy_identity=policy
interrupt_after_drain=1
suspension_expiry=expiry
suspension_state="$FIXTURE_SUSPENSION_STATE"
suspension_scope=system
suspension_release="$previous_release"
suspension_pid=111
suspension_generation=1110
suspension_write_custody=clear
drain_budget_elapsed=1
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
      if [[ "$FIXTURE_FAULT" == stale-lease ]]; then touch "$serving_root/lease-expired"; fi
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
    probes) printf READY ;;
    channels) printf CHANNELS_OK ;;
    validate-release)
      record "release-audit $2"
      if [[ "$FIXTURE_FAULT" == invalid-release ]]; then fail 'synthetic sealed release is invalid'; return 1; fi ;;
    gateway-runtime) : ;;
    *) return 90 ;;
  esac
}
run_gateway() {
  if [[ " $* " == *" system.info "* ]]; then
    record "rpc $active"
    if [[ "$active" == successor ]]; then ((SECONDS - successor_started >= FIXTURE_RPC_AT)) || return 1; fi
    printf '{"pid":%s,"processInstanceId":"fixture-instance"}' "$service_pid"
  fi
}
read_probe() { probe_body='{}'; probe_status=200; }
verify_marker() { record marker; recheck_generation "$2" "$verified_pid" "$verified_generation"; }
assert_frozen_predecessor() { :; }
assert_stop_start_contract() { :; }
read_process_instance() { printf fixture-instance; }
prepare_suspension() {
  record suspension; held_suspension=lease
  if [[ "$FIXTURE_FAULT" == current-changed ]]; then rm "$current_link"; ln -s "$candidate_release" "$current_link"; fi
}
poll_suspension() { record suspension-status; [[ ! -e "$serving_root/lease-expired" ]]; }
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
realpath() { if [[ -L "$1" ]]; then readlink "$1"; else printf '%s' "$previous_release"; fi; }
` + functions + String.raw`
if activate_release system; then exit 0; else activation_exit=$?; fi
rollback_activation "$activation_exit" || exit "$?"
`;
  const result = runShell(root, script, {
      FIXTURE_MODE: mode,
      FIXTURE_SUSPENSION_STATE: suspensionState,
      OPENCLAW_TEAM_RETRY_SECONDS: String(retrySeconds),
      FIXTURE_STOP_SECONDS: String(stopSeconds), FIXTURE_LISTENER_AT: String(listenerAt),
      FIXTURE_RPC_AT: String(rpcAt), FIXTURE_FAULT: fault,
  }, 90_000, 512 * 1024);
  const rows = readFileSync(join(root, "events"), "utf8").trim().split("\n").map(line => {
    const [at, ...event] = line.split(" "); return { at: Number(at), event: event.join(" ") };
  });
  const journal = existsSync(join(root, "journal.json")) ? JSON.parse(readFileSync(join(root, "journal.json"))) : null;
  const startIndex = rows.findIndex(row => row.event === "successor-start");
  return { result, rows, journal, started: rows[startIndex]?.at, afterStart: rows.slice(startIndex + 1) };
}

function successorCase(name, options, check, failure = false) {
  test(name, t => {
    const state = successorActivation(t, options), { result, rows, journal } = state;
    if (failure) {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /SUCCESS /);
      assert.match(result.stderr, failure);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /SUCCESS /);
      assert.equal(journal, null);
    }
    check({ ...state, events: event => rows.filter(row => row.event === event) });
  });
}

for (const [fault, reason] of [
  ["invalid-release", /synthetic sealed release is invalid/],
  ["current-changed", /current release changed before journal publication/],
  ["stale-lease", /SUSPENSION_CHECK_FAILED stage=status/],
]) {
  successorCase(`activation refuses ${fault} before journal or stop`, { pointers: true, fault },
    ({ journal, events }) => {
      assert.equal(journal, null);
      assert.equal(events("systemctl stop").length + events("successor-start").length, 0);
      if (fault === "invalid-release") { assert.equal(events("suspension").length, 0); }
    }, reason);
}
for (const suspensionState of ["DRAINING", "READY"]) {
  successorCase(`activation audits releases before closing ${suspensionState} admission`,
    { pointers: true, suspensionState, stopSeconds: 0, listenerAt: 0 }, ({ rows }) => {
      const stopping = rows.findIndex(row => row.event === "systemctl stop");
      const closed = rows.findIndex(row => row.event === "suspension");
      const audits = rows.slice(0, stopping).flatMap((row, index) => row.event.startsWith("release-audit ") ? [index] : []);
      assert.equal(audits.length, 2);
      assert.ok(audits.every(index => index < closed) && stopping >= 0, JSON.stringify(rows));
    });
}
for (const [mode, listenerAt, rpcAt, retrySeconds] of [
  ["runtime", 60, 90, 2], ["deploy", 60, 60, 2], ["deploy", 598, 598, 13],
]) {
  successorCase(`${mode} retains its full successor window with listener/RPC at ${listenerAt}/${rpcAt}`,
    { mode, listenerAt, rpcAt, retrySeconds }, ({ result, started, afterStart, events }) => {
      assert.equal(started, 1094);
      assert.equal(events("marker")[0].at - started, rpcAt);
      assert.equal(events("rollback-compatibility").length, 0);
      assert.equal(afterStart.some(row => row.event === "stopped-proof"), false);
      assert.equal((result.stderr.match(/VERIFICATION_WAITING stage=convergence.listener/g) ?? []).length, 1);
      assert.doesNotMatch(result.stderr, /VERIFICATION_FAILED stage=convergence.generation/);
      if (rpcAt > listenerAt) { assert.match(result.stderr, /stage=convergence.process-rpc/); }
    });
}
for (const fault of ["", "exit-at-budget"]) {
  successorCase(`listener budget expires before rollback: ${fault || "still running"}`,
    { listenerAt: 9999, fault, retrySeconds: 17 }, ({ result, journal, started, afterStart, events }) => {
      assert.equal(events("rollback-compatibility").length, 1);
      assert.equal(events("rollback-compatibility")[0].at - started, 600);
      assert.ok(afterStart.filter(row => row.event === "stopped-proof").every(row => row.at - started >= 600));
      assert.equal(events("systemctl restart").length, fault ? 1 : 0);
      if (fault) {
        assert.match(result.stderr, /ROLLED_BACK /);
        assert.equal(journal, null);
      } else {
        assert.deepEqual(journal, { phase: "ROLLBACK_FAILED", originalWitness: "fixture" });
        assert.equal(events("restore-pointers").length, 0);
      }
    }, /stage=wait-for-live.budget/);
}
for (const [fault, reason] of [
  ["generation", /started recovery Gateway generation changed/],
  ["foreign", /Gateway does not own one exact loopback listener/],
  ["policy", /stage=convergence.policy/],
  ["identity", /stage=convergence.protected-state/],
]) {
  successorCase(`${fault} drift never gains verification or rollback authority`,
    { listenerAt: fault === "generation" ? 60 : 0, fault, retrySeconds: 20 }, ({ journal, events }) => {
      assert.equal(events("marker").length + events("restore-pointers").length, 0);
      assert.deepEqual(journal, { phase: "ROLLBACK_FAILED", originalWitness: "fixture" });
    }, reason);
}

for (const [label, options, rejected] of [
  ["auth profiles are stripped", { policyModel: "fixture/exact-model@work", fallbacks: ["fixture/fallback@work"], effectiveModel: "fallback" }],
  ["configured fallback", { fallbacks: ["fixture/fallback"], effectiveModel: "fallback" }],
  ["unconfigured effective model", { effectiveModel: "other-model" }, true],
  ["different requested model", { requestedModel: "other-model", effectiveModel: "fallback" }, true],
  ["model-version suffix is not an auth profile", { fallbacks: ["fixture/fallback@20251001"], effectiveModel: "fallback" }, true],
]) {
  markerCase(`marker receipt: ${label}`, { fallbacks: ["fixture/fallback"], ...options },
    ({ events }) => assert.equal(events("native-run").length, 1), rejected && /stage=marker.reply-check/);
}
