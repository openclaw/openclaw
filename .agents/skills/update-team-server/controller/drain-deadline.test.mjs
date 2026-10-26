import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
function ownerFunction(name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `missing owner function ${name}`);
  return match[0];
}

// Execute maintained deadline, RPC-budget, and lease-proof control flow with a
// virtual clock and inert transport. This does not exercise GNU timeout itself.
function deadlinePoll(t, { firstExit = 124, fresh = "draining", interrupt = 1, generation = 0,
  expireBeforeRpc = false, firstMalformed = false, firstPayload = "", firstFailures = 1, elapsed = 30, freshExit = 0, second = null, drainBudget, leaseMs = 45_000, postDrainPollSeconds = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "team-drain-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, "release-lib.mjs");
  // Bind the unchanged pinned contract locally; production keeps its installed path.
  writeFileSync(library, readFileSync(new URL("./release-lib.mjs", import.meta.url), "utf8").replace(
    'const suspensionContractPath = "/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs";',
    `const suspensionContractPath = ${JSON.stringify(join(import.meta.dirname, "gateway-suspension-contract.mjs"))};`,
  ));
  const expiry = Date.now() + leaseMs;
  const blockers = [{ kind: "terminal-session", count: 1, message: "fixture terminal" }];
  const prepared = { status: "draining", suspensionId: "fixture-lease", expiresAtMs: expiry,
    activeCount: 1, retryAfterMs: 1000, blockers };
  let response = { status: "draining", expiresAtMs: expiry, activeCount: 1, retryAfterMs: 1000, blockers };
  if (fresh === "ready") {response = { status: "ready", expiresAtMs: expiry };}
  if (fresh === "persistence") {response.blockers = [{ kind: "terminal-persistence", count: 1, message: "fixture write" }];}
  if (fresh === "unknown") {response.blockers = [{ kind: "future-kind", count: 1, message: "fixture unknown" }];}
  if (fresh === "changed") {response.expiresAtMs += 1;}
  if (fresh === "expired") {response.expiresAtMs = Date.now() - 1;}
  if (fresh === "refused") {response = { status: "running" };}
  if (fresh === "custody") {response = { status: "draining", expiresAtMs: expiry, activeCount: 1, retryAfterMs: 1000,
    blockers: [{ kind: "session-mutation", count: 1, message: "fixture mutation" }], writeCustody: [{ phase: "final-chat-write", count: 1 }] };}
  const functions = ["proof_json", "run_gateway_node", "retain_suspension_cleanup_offer", "request_suspension",
    "prepare_suspension", "check_suspension"].map(ownerFunction).join("\n");
  const gateway = ownerFunction("run_gateway").replace(/^run_gateway/, "fixture_run_gateway");
  const originalPoll = ownerFunction("poll_suspension").replace(/^poll_suspension/, "fixture_poll_suspension");
  const program = `set -Eeuo pipefail
unset SECONDS
SECONDS=0
node_bin="$FIXTURE_NODE"
runuser_bin=unused
runtime_home=unused; config_file=unused; state_database=unused; runtime_dir=unused; bus_address=unused
verification_deadline=0; drain_deadline=0; drain_poll_interval=25
${source.match(/^drain_budget=.*$/m)[0]}
custody_wait_budget=5; custody_wait_interval=2
held_suspension=""; suspension_expiry=""; suspension_blockers=""
suspension_cleanup_only=0; suspension_handoff_started=0
suspension_scope=system; suspension_pid=123; suspension_generation=456
poll_count=0; interrupt_after_drain="$INTERRUPT"
proof() { "$node_bin" --no-warnings "$FIXTURE_LIB" "$@"; }
fail() { printf '%s\\n' "$*" >&2; return 1; }
sleep() { SECONDS=$((SECONDS + $1)); }
bounded() {
  local budget="$1"; shift
  if [[ "$*" == *'gateway call gateway.suspend.prepare '* ]]; then
    printf 'prepare\\n' >>"$EVENTS"
    printf '%s' "$PREPARED"
  elif [[ "$*" == *'gateway call gateway.suspend.status '* ]]; then
    printf 'status budget=%s poll=%s\\n' "$budget" "$poll_count" >>"$EVENTS"
    [[ "$*" == *'--params {"suspensionId":"fixture-lease"} --json --timeout '* ]] || return 91
    if ((poll_count <= FIRST_FAILURES)); then
      printf '%s' "$FIRST_PAYLOAD"
      return "$FIRST_EXIT"
    fi
    if ((poll_count == 2)) && [[ -n "$SECOND_PAYLOAD" ]]; then
      printf '%s' "$SECOND_PAYLOAD"
      return 0
    fi
    printf '%s' "$FRESH"
    return "$FRESH_EXIT"
  else
    return 92
  fi
}
recheck_generation() {
  printf 'generation\\n' >>"$EVENTS"
  [[ "$1 $2 $3" == 'system 123 456' ]] || return 93
  return "$GENERATION_EXIT"
}
${functions}
${originalPoll}
${gateway}
run_gateway() {
  # Request preparation can consume the last second after the loop's deadline check.
  if ((EXPIRE_BEFORE_RPC && poll_count == 1)); then SECONDS=30; fi
  fixture_run_gateway "$@"
}
poll_suspension() {
  local result
  poll_count=$((poll_count + 1))
  if fixture_poll_suspension "$@"; then result=0; else result=$?; fi
  # The first transport consumed the remainder of the graceful deadline.
  if ((poll_count == 1)); then SECONDS="$ELAPSED";
  else SECONDS=$((SECONDS + POST_DRAIN_POLL_SECONDS)); fi
  return "$result"
}
prepare_suspension /fixture
`;
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", program], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C", FIXTURE_NODE: process.execPath,
      OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
      ...(drainBudget === undefined ? {} : { OPENCLAW_TEAM_DRAIN_BUDGET: String(drainBudget) }),
      FIXTURE_LIB: library, EVENTS: join(root, "events"),
      EXPIRE_BEFORE_RPC: String(Number(expireBeforeRpc)), ELAPSED: String(elapsed), FRESH_EXIT: String(freshExit),
      POST_DRAIN_POLL_SECONDS: String(postDrainPollSeconds),
      INTERRUPT: String(interrupt), FIRST_FAILURES: String(firstFailures), FIRST_EXIT: String(firstExit), GENERATION_EXIT: String(generation),
      PREPARED: JSON.stringify(prepared), FIRST_PAYLOAD: firstMalformed ? "{}" : firstPayload,
      SECOND_PAYLOAD: second ? JSON.stringify(second(expiry)) : "",
      FRESH: fresh === "malformed" ? "{}" : JSON.stringify(response) },
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture (terminal|write|unknown)/);
  assert.equal(result.signal, null, result.stderr + result.stdout);
  let events;
  try { events = readFileSync(join(root, "events"), "utf8").trim().split("\n"); }
  catch (error) { if (error.code === "ENOENT") {events = [];} else {throw error;} }
  const preparations = events.filter((event) => event === "prepare").length;
  return { result, preparations, events: events.filter((event) => event !== "prepare") };
}

for (const fresh of ["draining", "ready"]) {
  test(`deadline-cancelled poll requires fresh ${fresh} lease and generation before acceptance`, (t) => {
    const { result, events } = deadlinePoll(t, { fresh });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /SUSPENSION_POLL_FAILED stage=rpc method=gateway.suspend.status exit=124/);
    assert.doesNotMatch(result.stderr, /SUSPENSION_CHECK_FAILED/);
    assert.deepEqual(events, ["status budget=5 poll=1", "status budget=5 poll=2", "generation"]);
    if (fresh === "draining") {assert.match(result.stdout, /INTERRUPTING authorized/);}
    else {assert.doesNotMatch(result.stdout, /INTERRUPTING/);}
  });
}
for (const fresh of ["persistence", "unknown", "changed", "expired", "refused", "malformed"]) {
  test(`deadline transition refuses fresh ${fresh} evidence`, (t) => {
    const { result, events } = deadlinePoll(t, { fresh });
    assert.equal(result.status, 75);
    assert.deepEqual(events.slice(0, 2), ["status budget=5 poll=1", "status budget=5 poll=2"]);
    if (fresh === "persistence") {
      assert.match(result.stderr, /SUSPENSION_CHECK_FAILED stage=policy exit=1 state=DRAINING activeCount=1 blockers=terminal-persistence:1 custody=unknown interruptAfterDrain=1 drainBudgetElapsed=1/);
      assert.doesNotMatch(result.stderr, /SUSPENSION_CHECK_FAILED stage=(status|generation)/);
    } else {
      assert.match(result.stderr, /SUSPENSION_POLL_FAILED stage=proof method=gateway.suspend.status exit=2/);
      assert.match(result.stderr, /SUSPENSION_CHECK_FAILED stage=status exit=1/);
      assert.doesNotMatch(result.stderr, /SUSPENSION_CHECK_FAILED stage=policy/);
    }
    assert.doesNotMatch(result.stdout, /INTERRUPTING/);
  });
}
test("deadline transition refuses changed process ownership", (t) => {
  const { result, events } = deadlinePoll(t, { generation: 1 });
  assert.equal(result.status, 75);
  assert.equal(events.at(-1), "generation");
  assert.match(result.stderr, /SUSPENSION_CHECK_FAILED stage=generation exit=1/);
  assert.doesNotMatch(result.stderr, /SUSPENSION_CHECK_FAILED stage=policy/);
  assert.doesNotMatch(result.stdout, /INTERRUPTING/);
});
for (const options of [{ interrupt: 0 }, { firstExit: 1 }, { firstExit: 137 },
  { firstExit: 0, firstMalformed: true }]) {
  test(`failed poll cannot enter deadline interruption: ${JSON.stringify(options)}`, (t) => {
    const { result, events } = deadlinePoll(t, options);
    assert.equal(result.status, 75);
    assert.deepEqual(events, ["status budget=5 poll=1"]);
    assert.match(result.stderr, options.firstMalformed
      ? /SUSPENSION_POLL_FAILED stage=proof method=gateway.suspend.status exit=2/
      : new RegExp(`SUSPENSION_POLL_FAILED stage=rpc method=gateway.suspend.status exit=${options.firstExit ?? 124}`));
    assert.doesNotMatch(result.stdout, /INTERRUPTING/);
  });
}

test("deadline transition refuses a failed fresh status read", (t) => {
  const { result, events } = deadlinePoll(t, { freshExit: 1 });
  assert.equal(result.status, 75);
  assert.deepEqual(events, ["status budget=5 poll=1", "status budget=5 poll=2"]);
  assert.match(result.stderr, /SUSPENSION_POLL_FAILED stage=rpc method=gateway.suspend.status exit=1/);
  assert.match(result.stderr, /SUSPENSION_CHECK_FAILED stage=status exit=1/);
  assert.doesNotMatch(result.stderr, /SUSPENSION_CHECK_FAILED stage=policy/);
  assert.doesNotMatch(result.stdout, /INTERRUPTING/);
});

const custodyHeld = (expiry) => ({ status: "draining", expiresAtMs: expiry, activeCount: 1, retryAfterMs: 1000,
  blockers: [{ kind: "session-mutation", count: 1, message: "fixture mutation" }],
  writeCustody: [{ phase: "final-chat-write", count: 1 }] });

test("transient write custody after the drain budget is re-polled and then interrupted", (t) => {
  const { result, events } = deadlinePoll(t, { second: custodyHeld });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /WAITING transient write custody activeCount=1 blockers=session-mutation:1/);
  assert.match(result.stdout, /INTERRUPTING authorized/);
  assert.doesNotMatch(result.stderr, /SUSPENSION_CHECK_FAILED stage=(status|generation)/);
  assert.ok(events.filter((e) => e.startsWith("status")).length >= 3, events.join(","));
});

test("write custody held past the bounded window still refuses interruption", (t) => {
  const { result } = deadlinePoll(t, { fresh: "custody", second: custodyHeld });
  assert.equal(result.status, 75);
  assert.match(result.stdout, /WAITING transient write custody/);
  assert.match(result.stderr, /SUSPENSION_CHECK_FAILED stage=policy exit=1 state=DRAINING activeCount=1 blockers=session-mutation:1 custody=held/);
  assert.doesNotMatch(result.stdout, /INTERRUPTING/);
});

test("expired custody wait is reported without dispatching another status RPC", (t) => {
  const { result, events } = deadlinePoll(t, {
    firstFailures: 0, fresh: "custody", postDrainPollSeconds: 3,
  });
  assert.equal(result.status, 75, result.stderr + result.stdout);
  assert.match(result.stdout, /WAITING transient write custody/);
  assert.match(result.stdout, /DEFERRED bounded interruption write custody wait expired activeCount=1 blockers=session-mutation:1/);
  assert.doesNotMatch(result.stdout, /INTERRUPTING/);
  assert.equal(events.filter((event) => event.startsWith("status")).length, 2);
  assert.doesNotMatch(result.stderr, /SUSPENSION_POLL_FAILED|SUSPENSION_CHECK_FAILED stage=status/,
    "Both dispatched status calls succeeded; the custody deadline expired during the next sleep.");
});

const transportFailure = (kind, code) => JSON.stringify({ ok: false,
  error: { type: "gateway_transport_error", kind, ...(code === undefined ? {} : { code }),
    message: "private-fixture-do-not-log" },
  gateway: { url: "ws://127.0.0.1:40000", urlSource: "fixture" } });
for (const [name, firstExit, firstPayload] of [
  ["request timeout", 1, transportFailure("timeout")],
  ["connection loss", 1, transportFailure("closed", 1006)],
  ["service restart", 1, transportFailure("closed", 1012)],
  ["outer timeout", 124, ""],
]) {
  test(`transient ${name} during drain retries before the original deadline`, (t) => {
    const { result, events } = deadlinePoll(t, { firstExit, firstPayload, elapsed: 26, fresh: "ready" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /SUSPENSION_POLL_RETRY/);
    assert.equal(events.filter((event) => event.startsWith("status")).length, 2);
    assert.doesNotMatch(result.stdout, /INTERRUPTING/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-fixture-do-not-log/);
  });
}

for (const [name, firstExit, firstPayload] of [
  ["credentials", 1, JSON.stringify({ ok: false, error: { type: "gateway_credentials_required" } })],
  ["request refusal", 1, JSON.stringify({ ok: false, error: { type: "gateway_request_error", code: "UNAVAILABLE", retryable: true } })],
  ["policy close", 1, transportFailure("closed", 1008)],
  ["protocol close", 1, transportFailure("closed", 1002)],
  ["malformed timeout output", 124, "{"],
  ["missing transport fields", 1, JSON.stringify({ ok: false, error: { type: "gateway_transport_error", kind: "timeout" } })],
  ["wrong transport field type", 1, transportFailure("closed", "1006")],
  ["refusal at subprocess deadline", 124, transportFailure("closed", 1008)],
]) {
  test(`drain poll keeps ${name} fatal`, (t) => {
    const { result, events } = deadlinePoll(t, { firstExit, firstPayload, elapsed: 26, fresh: "ready" });
    assert.equal(result.status, 75, result.stderr + result.stdout);
    assert.equal(events.length, 1);
    assert.doesNotMatch(result.stderr, /SUSPENSION_POLL_RETRY/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-fixture-do-not-log/);
  });
}

test("repeated transient polls exhaust only the original drain budget", (t) => {
  const { result, events } = deadlinePoll(t, { firstExit: 1, firstPayload: transportFailure("timeout"),
    firstFailures: 99, elapsed: 26, interrupt: 0 });
  assert.equal(result.status, 75, result.stderr + result.stdout);
  assert.deepEqual(events, ["status budget=5 poll=1", "status budget=3 poll=2", "status budget=1 poll=3"]);
  assert.deepEqual([...result.stderr.matchAll(/SUSPENSION_POLL_RETRY backoffSeconds=(\d+)/g)].map((match) => match[1]), ["1", "2", "1"]);
  assert.match(result.stdout, /exceeded its 30-second budget/);
  assert.doesNotMatch(result.stdout, /INTERRUPTING/);
});

for (const options of [{ fresh: "draining" }, { fresh: "persistence" }, { interrupt: 0 }]) {
  test(`drain deadline before RPC dispatch uses the deadline policy: ${JSON.stringify(options)}`, (t) => {
    const { result, events } = deadlinePoll(t, { expireBeforeRpc: true, ...options });
    assert.equal(result.status, options.fresh === "draining" ? 0 : 75, result.stderr + result.stdout);
    assert.match(result.stderr, /SUSPENSION_POLL_FAILED stage=rpc method=gateway.suspend.status exit=124/);
    if (options.interrupt === 0) {
      assert.deepEqual(events, []);
      assert.match(result.stdout, /exceeded its 30-second budget/);
    } else {
      assert.deepEqual(events, ["status budget=5 poll=2", "generation"]);
    }
    if (options.fresh === "draining") {assert.match(result.stdout, /INTERRUPTING authorized/);}
    else {assert.doesNotMatch(result.stdout, /INTERRUPTING/);}
  });
}

for (const drainBudget of [undefined, 600]) {
  test(`drain defaults and overrides remain bounded without renewing: ${drainBudget ?? "default"}`, (t) => {
    const { result, preparations } = deadlinePoll(t, {
      drainBudget, leaseMs: 20_000, interrupt: 0,
    });
    assert.equal(result.status, 75, result.stderr + result.stdout);
    assert.equal(preparations, 1, "drain polling must not prepare another lease");
    assert.match(result.stdout, /exceeded its 30-second budget/);
    if (drainBudget !== undefined) {
      assert.match(result.stderr, /DRAIN_BUDGET_CAPPED requested=600 effective=30/);
    }
  });
}
