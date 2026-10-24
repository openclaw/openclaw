import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ownerPath = process.env.MARKER_DEADLINE_TEST_OWNER ??
  join(dirname(fileURLToPath(import.meta.url)), "openclaw-release-deploy");

// Exercise the actual shell control flow with synthetic external effects and time.
// This does not prove GNU timeout, process capabilities, or live Gateway behavior.
function ownerFunction(source, name, optional = false) {
  const declarations = [...source.matchAll(/^([a-zA-Z_][a-zA-Z_0-9]*)\(\) \{/gm)];
  const index = declarations.findIndex((match) => match[1] === name);
  if (index === -1 && optional) {
    return "";
  }
  assert.notEqual(index, -1, `missing owner function ${name}`);
  return source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length);
}

function deadlineRecovery(t, terminalAtMs, failure = null, admissionReadyAtMs = 0, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "team-marker-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "journal.json"), events = join(root, "events.jsonl");
  const before = "a".repeat(40), after = "b".repeat(40);
  for (const sha of [before, after]) {
    const sdk = join(root, sha, "dist/plugin-sdk");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(root, sha, "package.json"), '{"type":"module"}');
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
  }
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
const eventLoop=atMs=>{
  const delayed=atMs<Number(process.env.FIXTURE_LOOP_READY_AT_MS),busy=process.env.FIXTURE_BUSY_CPU==="1";
  return {degraded:delayed||busy,reasons:[...(delayed?["event_loop_delay"]:[]),...(busy?["cpu","event_loop_utilization"]:[])],
    intervalMs:1000,delayP99Ms:delayed?1000:busy?50:0,delayMaxMs:delayed?1000:busy?50:0,
    utilization:busy?1:0.1,cpuCoreRatio:busy?1.2:0.1,degradedSinceMs:delayed||busy?0:null};
};
if(kind==="proof") {
  const [operation,...rest]=args;
  record({kind:"proof",operation});
  switch(operation) {
    case "worker-config": process.stdout.write("none"); break;
    case "journal-read": process.stdout.write(readFileSync(rest[0],"utf8")); break;
    case "journal-field": {
      const value=rest[1].split(".").reduce((value,key)=>value[key],JSON.parse(readFileSync(rest[0],"utf8")));
      process.stdout.write(typeof value==="object"?JSON.stringify(value):String(value)); break;
    }
    case "journal-original-witness": case "recovery-snapshot": emit({}); break;
    case "validate-release": emit({buildId:"fixture"}); break;
    case "policy": process.stdout.write(process.env.FIXTURE_POLICY); break;
    case "approvals": process.stdout.write("0"); break;
    case "session-preservation-verify": case "compatibility": case "recovery-check": case "gateway-runtime": break;
    case "recovery-finish": case "unlink-exact": record({kind:operation}); unlinkSync(rest[0]); break;
    case "journal-phase": {
      const value=JSON.parse(readFileSync(rest[0],"utf8"));
      writeFileSync(rest[0],JSON.stringify({...value,phase:rest[1]}));break;
    }
    case "service-restart": record({kind:operation}); break;
    default: throw Error("unexpected proof operation "+operation);
  }
} else if(kind==="rpc") {
  const [method,raw,clientBudget,clock]=args,params=JSON.parse(raw),atMs=Number(clock);
  record({kind:method,atMs,clientBudget:Number(clientBudget),nativeWait:params.timeoutMs,idempotencyKey:params.idempotencyKey});
  if(method==="system.info") {
    if(atMs<Number(process.env.FIXTURE_RPC_READY_AT_MS)) {process.stdout.write("RETRYABLE_READINESS_TRANSPORT");process.exit(78);}
    emit({pid:123,processInstanceId:process.env.FIXTURE_PROCESS_DRIFT==="1"?"wrong-instance":"fixture-instance"});
  } else if(method==="channels.status") {
    emit({eventLoop:eventLoop(atMs),channelAccounts:Object.fromEntries(JSON.parse(process.env.OPENCLAW_TEAM_OPERATOR_PROFILE).channels.map(([channel,accountId])=>
      [channel,[{accountId,configured:true,enabled:true,running:true,connected:true,lifecycle:"ready",restartPending:false,lastError:null}]]))});
  } else if(method==="sessions.list") {emit({sessions:[]});
  } else if(method==="agent") {
    if(atMs<Number(process.env.FIXTURE_ADMISSION_READY_AT_MS)) {process.stdout.write("RETRYABLE_ADMISSION_PENDING");process.exit(76);}
    const dispatchFailure=JSON.parse(process.env.FIXTURE_DISPATCH_FAILURE), accepted=join(root,"accepted.json");
    let prior; try {prior=readFileSync(accepted,"utf8");} catch(error) {if(error.code!=="ENOENT")throw error;}
    if(prior) assert.equal(prior,raw,"retry must preserve the exact native request");
    else {writeFileSync(accepted,raw);record({kind:"native-run",runId:params.idempotencyKey});}
    if(dispatchFailure&&(!dispatchFailure.once||!prior)) {process.stdout.write(dispatchFailure.output);process.exit(dispatchFailure.exit);}
    emit(prior?{status:"in_flight",runId:params.idempotencyKey}:{status:"accepted",runId:params.idempotencyKey,agentId:params.agentId,sessionKey:params.sessionKey});
  } else {
    const accepted=JSON.parse(readFileSync(join(root,"accepted.json"),"utf8"));
    assert.equal(method,"agent.wait"); assert.equal(params.runId,accepted.idempotencyKey);
    const failure=JSON.parse(process.env.FIXTURE_OBSERVATION_FAILURE);
    if(failure) {process.stdout.write(failure.output);process.exit(failure.exit);}
    if(atMs<Number(process.env.FIXTURE_TERMINAL_AT_MS)) emit({runId:params.runId,status:"timeout"});
    else {
      emit({runId:params.runId,status:"ok",endedAt:atMs,stopReason:"stop",
        terminalReply:{disposition:"visible",text:accepted.message.split(": ").at(-1)},
        terminalReceipt:{runId:params.runId,sessionId:accepted.sessionId,turnId:"fixture-turn",
          requested:{provider:"fixture",model:process.env.FIXTURE_REQUESTED_MODEL},
          terminalDisposition:"visible",effective:{provider:"fixture",model:process.env.FIXTURE_EFFECTIVE_MODEL}}});
    }
  }
} else if(kind==="probe") {
  const [endpoint,clock]=args,atMs=Number(clock);
  if(atMs<Number(process.env.FIXTURE_PROBE_READY_AT_MS))process.exit(28);
  if(endpoint==="healthz") emit({ok:true,status:"live"});
  else if(endpoint==="startupz") emit(atMs<Number(process.env.FIXTURE_STARTUP_READY_AT_MS)||process.env.FIXTURE_OTHER_AGENT_PENDING==="1"
    ?{ok:false,status:"starting",pendingReason:process.env.FIXTURE_OTHER_AGENT_PENDING==="1"?"agent-database-inspection":"startup-sidecars",uptimeMs:atMs}:{ok:true,status:"started",uptimeMs:atMs});
  else {
    const pending=atMs<Number(process.env.FIXTURE_MARKER_READY_AT_MS),code=process.env.FIXTURE_REFUSAL_CODE;
    const agentDatabases=[...(process.env.FIXTURE_OTHER_AGENT_PENDING==="1"?[{agentId:"other-agent",code:"agent-database-inspection-pending"}]:[]),
      ...(pending||code?[{agentId:JSON.parse(process.env.OPENCLAW_TEAM_OPERATOR_PROFILE).modelAgent,code:code||"agent-database-inspection-pending"}]:[])];
    const ready=atMs>=Number(process.env.FIXTURE_READYZ_READY_AT_MS);
    emit({ready,failing:ready?[]:["discord"],uptimeMs:atMs,eventLoop:eventLoop(atMs),...(agentDatabases.length?{agentDatabases}:{})});
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
    "load_journal_witness", "wait_for_live", "recover_journal", "rollback_activation"].map((name) => ownerFunction(source, name, name === "wait_for_marker_readiness")).join("\n");
  const convergenceOwner = ownerFunction(source, "verify_convergence").replace(/^verify_convergence\(\)/, "verify_convergence_owner()");
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
policy_identity="$FIXTURE_POLICY"
node_bin="$FIXTURE_NODE"
allow_cpu_degraded=0
gateway_runtime_snapshot=""
arm_steady_profile=0
profile_finished=0
profile_operation=""
proof() {
  if [[ "$1" == marker-readiness || "$1" == probes || "$1" == channels ]]; then "$node_bin" "$FIXTURE_LIBRARY" "$@"
  else "$node_bin" "$FIXTURE_HELPER" proof "$@"; fi
}
read_pointer() { readlink "$1"; }
fail() { printf '%s\n' "$*" >&2; return 1; }
migration_check_existing_guard() { :; }
assert_protected_identity() { :; }
assert_policy() { :; }
assert_exclusive_owner() { :; }
capture_generation() { service_pid=123; service_generation=456; }
capture_service_generation() { capture_generation; }
assert_single_listener() { :; }
recheck_generation() { :; }
rollback_armed=1
predecessor_stopped=1
restart_failed=0
native_update_root=""
candidate_release="$FIXTURE_ROOT/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
previous_release="$FIXTURE_ROOT/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
previous_info='{"buildId":"fixture"}'
proc_root="$FIXTURE_ROOT/proc"
record_failed() { :; }
predecessor_is_stopped() { :; }
restore_pointer_topology() { ln -sfn "$previous_release" "$current_link"; }
system_systemctl() { [[ "$1" == restart ]] || return 90; proof service-restart; }
realpath() { printf '%s' "$previous_release"; }
verify_convergence() {
  # Convergence has used 590 seconds of the existing 600-second deadline.
  if ((clock_ms == 0)); then clock_ms="$FIXTURE_CONVERGENCE_AT_MS"; SECONDS=$((clock_ms / 1000)); fi
  verified_pid=123; verified_generation=456; verified_instance=fixture-instance
  if [[ "$FIXTURE_NATIVE_CONVERGENCE" == 1 ]]; then verify_convergence_owner "$@"; fi
}
proof_json() { [[ "$1" == gateway-status ]]; }
assert_scheduler_owner() { :; }
run_marker_rpc() { "$node_bin" "$FIXTURE_HELPER" rpc "$2" "$3" "$4" "$clock_ms"; }
run_gateway_node() { "$node_bin" "$@"; }
read_probe() {
  local body
  body="$("$node_bin" "$FIXTURE_HELPER" probe "$1" "$clock_ms")" || return "$?"
  probe_body="$body"; probe_status=200
  if [[ "$1" == readyz ]] && ((clock_ms < FIXTURE_READYZ_READY_AT_MS)); then probe_status=503; fi
  if [[ "$1" == startupz ]] && { ((clock_ms < FIXTURE_STARTUP_READY_AT_MS)) || [[ "$FIXTURE_OTHER_AGENT_PENDING" == 1 ]]; }; then probe_status=503; fi
}
run_gateway() {
  if [[ "$FIXTURE_NATIVE_CONVERGENCE" != 1 ]]; then printf '{"pid":123,"processInstanceId":"fixture-instance"}'; return; fi
  if [[ "$3" == status ]]; then printf '{}'; else run_marker_rpc "$1" "$4" "$6" "$9"; fi
}
sleep() { bounded "$((verification_deadline - SECONDS))" sleep "$1"; }
bounded() {
  local budget="$1" milliseconds
  shift
  [[ "$1" == sleep && "$#" == 2 ]] || return 90
  milliseconds="$("$node_bin" "$FIXTURE_HELPER" pause "$clock_ms" "$budget" "$2")" || return 1
  clock_ms=$((clock_ms + milliseconds)); SECONDS=$((clock_ms / 1000))
}
` + functions + "\n" + convergenceOwner + String.raw`
if [[ "$FIXTURE_FLOW" == rollback ]]; then rollback_activation 1; exit "$?"; fi
if recover_journal; then exit 0; else exit "$?"; fi
`;
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8", timeout: options.nativeConvergence ? 90_000 : 20_000, maxBuffer: 256 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C", LC_ALL: "C",
      OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
      FIXTURE_ROOT: root, FIXTURE_HELPER: helper, FIXTURE_NODE: process.execPath,
      FIXTURE_POLICY: JSON.stringify({ model: options.policyModel ?? "fixture/exact-model", fallbacks: options.fallbacks ?? [] }),
      FIXTURE_REQUESTED_MODEL: options.requestedModel ?? "exact-model",
      FIXTURE_EFFECTIVE_MODEL: options.effectiveModel ?? "exact-model",
      FIXTURE_TERMINAL_AT_MS: String(terminalAtMs), FIXTURE_OBSERVATION_FAILURE: JSON.stringify(failure),
      FIXTURE_ADMISSION_READY_AT_MS: String(admissionReadyAtMs),
      FIXTURE_LIBRARY: join(dirname(ownerPath), "release-lib.mjs"),
      FIXTURE_CONVERGENCE_AT_MS: String(options.convergenceAtMs ?? 590_000),
      FIXTURE_MARKER_READY_AT_MS: String(options.markerReadyAtMs ?? 0),
      FIXTURE_READYZ_READY_AT_MS: String(options.readyzReadyAtMs ?? 0),
      FIXTURE_STARTUP_READY_AT_MS: String(options.startupReadyAtMs ?? 0),
      FIXTURE_RPC_READY_AT_MS: String(options.rpcReadyAtMs ?? 0),
      FIXTURE_LOOP_READY_AT_MS: String(options.loopReadyAtMs ?? 0),
      FIXTURE_PROBE_READY_AT_MS: String(options.probeReadyAtMs ?? 0),
      FIXTURE_DISPATCH_FAILURE: JSON.stringify(options.dispatchFailure ?? null),
      FIXTURE_PROCESS_DRIFT: options.processDrift ? "1" : "0",
      FIXTURE_REFUSAL_CODE: options.refusalCode ?? "", FIXTURE_FLOW: options.flow ?? "recover",
      FIXTURE_NATIVE_CONVERGENCE: options.nativeConvergence ? "1" : "0",
      FIXTURE_BUSY_CPU: options.busyCpu ? "1" : "0",
      FIXTURE_OTHER_AGENT_PENDING: options.otherAgentPending ? "1" : "0" },
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

test("healthy dispatch timeout reconciles the same native run after fresh readiness", (t) => {
  const { result, rows, journal } = deadlineRecovery(t, 596_000, null, 0, {
    dispatchFailure: { exit: 77, output: "RETRYABLE_DISPATCH_TIMEOUT", once: true },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(journal), false);
  assert.equal(rows.filter(row => row.kind === "native-run").length, 1);
  const dispatches = rows.filter(row => row.kind === "agent");
  assert.equal(dispatches.length, 2);
  assert.equal(new Set(dispatches.map(row => row.idempotencyKey)).size, 1);
  const retries = rows.indexOf(dispatches[1]);
  assert.ok(rows.slice(rows.indexOf(dispatches[0]) + 1, retries).some(row => row.kind === "system.info"));
});

test("marker waits for critical startup, agent admission and responsive probes inside the original budget", (t) => {
  const { result, rows } = deadlineRecovery(t, 596_000, null, 0, {
    startupReadyAtMs: 591_000, markerReadyAtMs: 592_000,
    probeReadyAtMs: 593_000, rpcReadyAtMs: 596_000, loopReadyAtMs: 594_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const dispatches = rows.filter(row => row.kind === "agent");
  assert.equal(dispatches.length, 1);
  assert.ok(dispatches[0].atMs >= 596_000 && dispatches[0].atMs < 600_000);
});

test("marker waits for native readiness to recover after convergence without renewing the deadline", (t) => {
  const { result, rows, journal } = deadlineRecovery(t, 596_000, null, 0, {
    readyzReadyAtMs: 596_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(journal), false);
  const dispatches = rows.filter(row => row.kind === "agent");
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].atMs, 596_000);
});

test("persistent native not-ready retains recovery evidence at the original deadline", (t) => {
  const { result, rows, journal, original } = deadlineRecovery(t, Infinity, null, 0, {
    readyzReadyAtMs: 601_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stage=marker.readiness-budget/);
  assert.equal(readFileSync(journal, "utf8"), original);
  assert.equal(rows.filter(row => row.kind === "agent").length, 0);
  const pauses = rows.filter(row => row.kind === "pause");
  assert.equal(pauses.at(-1).atMs + pauses.at(-1).ms, 600_000);
});

for (const [label, options] of [
  ["unclassified dispatch failure", { dispatchFailure: { exit: 77, output: "not a typed timeout" } }],
  ["corrupt agent store", { refusalCode: "agent-database-inspection-failed" }],
  ["changed process instance", { processDrift: true }],
  ["readiness never settles", { markerReadyAtMs: Infinity }],
  ["dispatch timeout persists", { convergenceAtMs: 596_000, dispatchFailure: { exit: 77, output: "RETRYABLE_DISPATCH_TIMEOUT" } }],
]) {
  test(`${label} retains evidence and never renews the marker deadline`, (t) => {
  const { result, rows, journal, original } = deadlineRecovery(t, Infinity, null, 0, options);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(readFileSync(journal, "utf8"), original);
  assert.doesNotMatch(result.stdout, /MARKER_VERIFIED|RECOVERED/);
  assert.ok(rows.filter(row => ["agent", "agent.wait"].includes(row.kind)).every(row => row.atMs < 600_000));
  assert.ok(rows.filter(row => row.kind === "native-run").length <= 1);
  });
}

test("rollback gives a healthy predecessor the same admission and timeout reconciliation patience", (t) => {
  const { result, rows, journal } = deadlineRecovery(t, 598_000, null, 0, {
    flow: "rollback", markerReadyAtMs: 593_000,
    dispatchFailure: { exit: 77, output: "RETRYABLE_DISPATCH_TIMEOUT", once: true },
  });
  assert.equal(result.status, 1, "rollback preserves the original activation failure exit");
  assert.match(result.stderr, /ROLLED_BACK/);
  assert.doesNotMatch(result.stderr, /activation rollback failed/);
  assert.equal(existsSync(journal), false);
  assert.equal(rows.filter(row => row.kind === "service-restart").length, 1);
  assert.equal(rows.filter(row => row.kind === "native-run").length, 1);
  assert.equal(rows.filter(row => row.kind === "agent").length, 2);
});

test("native RPC runner retries typed dispatch/readiness timeouts and rejects real failures", (t) => {
  const root = mkdtempSync(join(tmpdir(), "team-marker-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist/plugin-sdk"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "dist/plugin-sdk/gateway-runtime.js"), `
export function isGatewayTransportError(error) { return error.name === "GatewayTransportError"; }
export async function callGatewayFromCli() { throw Object.assign(new Error("synthetic failure"), JSON.parse(process.env.FIXTURE_ERROR)); }
`);
  const source = readFileSync(ownerPath, "utf8");
  const script = `set -Eeuo pipefail
run_gateway_node() { "$FIXTURE_NODE" "$@"; }
${ownerFunction(source, "run_marker_rpc")}
run_marker_rpc "$FIXTURE_ROOT" "$FIXTURE_METHOD" '{}' 10000
`;
  for (const [method, error, exit, output] of [
    ["agent", { name: "GatewayTransportError", kind: "timeout" }, 77, "RETRYABLE_DISPATCH_TIMEOUT"],
    ["system.info", { name: "GatewayTransportError", kind: "timeout" }, 78, "RETRYABLE_READINESS_TRANSPORT"],
    ["agent", { name: "GatewayTransportError", kind: "closed", code: 1002 }, 1, ""],
    ["agent", { name: "GatewayClientRequestError", code: "UNAUTHORIZED" }, 1, ""],
    ["agent", { name: "GatewayClientRequestError", code: "UNAVAILABLE", details: { code: "agent-database-inspection-failed" } }, 1, ""],
  ]) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf8", timeout: 5000,
      env: { PATH: "/usr/bin:/bin", FIXTURE_NODE: process.execPath, FIXTURE_ROOT: root,
        FIXTURE_METHOD: method, FIXTURE_ERROR: JSON.stringify(error) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, exit, result.stderr);
    assert.equal(result.stdout, output);
  }
});

for (const [label, options, firstDispatchAtMs] of [
  ["responsive sustained CPU/utilization load", { busyCpu: true }, 590_000],
  ["event-loop delay settles within the shared budget", { busyCpu: true, loopReadyAtMs: 592_000 }, 592_000],
  ["another agent still inspects after the model agent is admitted", { otherAgentPending: true }, 590_000],
  ["model agent admission waits while another agent also inspects", { otherAgentPending: true, markerReadyAtMs: 593_000 }, 593_000],
]) {
  test(`native convergence: ${label} completes the default marker without a CPU waiver`, (t) => {
    const { result, rows, journal } = deadlineRecovery(t, firstDispatchAtMs, null, 0, { ...options, nativeConvergence: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MARKER_VERIFIED/);
    assert.doesNotMatch(result.stdout, /CPU_DEGRADED_OPERATOR_WAIVED/);
    assert.equal(existsSync(journal), false);
    const dispatches = rows.filter(row => row.kind === "agent");
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].atMs >= firstDispatchAtMs && dispatches[0].atMs < 600_000);
  });
}

function successorActivation(t, { stopSeconds = 94, listenerAt = 60, rpcAt = listenerAt,
  fault = "", mode = "deploy", retrySeconds = 2, pointers = false, suspensionState = "DRAINING" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "team-successor-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
releases_root="$serving_root"
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
native_update_root=""
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
suspension_state="$FIXTURE_SUSPENSION_STATE"
suspension_cleanup_only=0
suspension_scope=system
suspension_release="$previous_release"
suspension_pid=111
suspension_generation=1110
suspension_write_custody=clear
suspension_blockers=""
drain_budget_elapsed=1
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
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8", timeout: 90_000, maxBuffer: 512 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C", LC_ALL: "C",
      OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
      FIXTURE_ROOT: root, FIXTURE_NODE: process.execPath, FIXTURE_MODE: mode,
      FIXTURE_SUSPENSION_STATE: suspensionState,
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

test("activation preparation: a rejected sealed release leaves admission open", t => {
  const { result, rows, journal } = successorActivation(t, { pointers: true, fault: "invalid-release" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /synthetic sealed release is invalid/);
  assert.equal(rows.some(row => row.event === "suspension"), false);
  assert.equal(journal, null);
});

for (const suspensionState of ["DRAINING", "READY"]) {
  test(`activation preparation: ${suspensionState} audits sealed releases before closing admission`, t => {
    const { result, rows } = successorActivation(t, { pointers: true, suspensionState, stopSeconds: 0, listenerAt: 0 });
    assert.equal(result.status, 0, result.stderr);
    const closed = rows.findIndex(row => row.event === "suspension");
    const stopping = rows.findIndex(row => row.event === "systemctl stop");
    const audits = rows.slice(0, stopping).flatMap((row, index) => row.event.startsWith("release-audit ") ? [index] : []);
    assert.equal(audits.length, 2);
    assert.ok(audits.every(index => index < closed), JSON.stringify(rows));
    assert.ok(rows.some(row => row.event === "systemctl stop"));
  });
  for (const fault of ["current-changed", "stale-lease"]) {
    test(`activation preparation: ${suspensionState} rejects ${fault} before journal or stop`, t => {
      const { result, rows, journal } = successorActivation(t, { pointers: true, suspensionState, fault });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, fault === "current-changed" ? /current release changed before journal publication/ : /SUSPENSION_CHECK_FAILED stage=status/);
      assert.equal(journal, null);
      assert.equal(rows.some(row => row.event === "systemctl stop" || row.event === "successor-start"), false);
    });
  }
}

for (const mode of ["runtime", "deploy"]) test(`successor convergence: ${mode} waits for a late listener and RPC after a 94-second stop`, t => {
  const rpcAt = mode === "runtime" ? 90 : 60;
  const { result, rows, journal, started, afterStart } = successorActivation(t, { mode, rpcAt });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SUCCESS /);
  assert.equal((result.stderr.match(/VERIFICATION_WAITING stage=convergence.listener/g) ?? []).length, 1);
  assert.doesNotMatch(result.stderr, /VERIFICATION_FAILED stage=convergence.generation/);
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
  assert.equal((result.stderr.match(/VERIFICATION_WAITING stage=convergence.listener/g) ?? []).length, 1);
  assert.doesNotMatch(result.stderr, /VERIFICATION_FAILED stage=convergence.generation/);
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

for (const flow of ["recover", "rollback"]) {
test(`marker configured fallback completes ${flow} with its original run`, (t) => {
  const { result, rows, journal } = deadlineRecovery(t, 590_000, null, 0, {
    flow, fallbacks: ["fixture/fallback"], effectiveModel: "fallback",
  });
  assert.equal(result.status, flow === "rollback" ? 1 : 0, result.stderr);
  assert.match(result.stdout, /MARKER_VERIFIED /);
  if (flow === "rollback") {
    assert.match(result.stderr, /ROLLED_BACK sha=/);
  }
  assert.equal(existsSync(journal), false);
  assert.equal(rows.filter(row => row.kind === "native-run").length, 1);
});
}

for (const [label, options] of [
  ["unconfigured effective model", { effectiveModel: "other-model" }],
  ["different requested model", { requestedModel: "other-model", effectiveModel: "fallback" }],
]) {
test(`marker configured fallback rejects ${label} and retains recovery evidence`, (t) => {
  const { result, journal } = deadlineRecovery(t, 590_000, null, 0, {
    fallbacks: ["fixture/fallback"], ...options,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stage=marker.reply-check/);
  assert.equal(existsSync(journal), true);
});
}

test("marker configured fallback resolves auth profiles through the serving release SDK", (t) => {
  const { result, rows, journal } = deadlineRecovery(t, 590_000, null, 0, {
    policyModel: "fixture/exact-model@work", fallbacks: ["fixture/fallback@work"], effectiveModel: "fallback",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MARKER_VERIFIED /);
  assert.equal(existsSync(journal), false);
  assert.equal(rows.filter(row => row.kind === "native-run").length, 1);
});

test("marker configured fallback preserves model-version suffixes during receipt comparison", (t) => {
  const { result, journal } = deadlineRecovery(t, 590_000, null, 0, {
    fallbacks: ["fixture/fallback@20251001"], effectiveModel: "fallback",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stage=marker.reply-check/);
  assert.equal(existsSync(journal), true);
});
