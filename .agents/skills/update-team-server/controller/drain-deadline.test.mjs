import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  firstMalformed = false, elapsed = 30, freshExit = 0, second = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "team-drain-deadline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const expiry = Date.now() + 120_000;
  const blockers = [{ kind: "terminal-session", count: 1, message: "fixture terminal" }];
  const prepared = { status: "draining", suspensionId: "fixture-lease", expiresAtMs: expiry,
    activeCount: 1, retryAfterMs: 1000, blockers };
  let response = { status: "draining", expiresAtMs: expiry, activeCount: 1, retryAfterMs: 1000, blockers };
  if (fresh === "ready") response = { status: "ready", expiresAtMs: expiry };
  if (fresh === "persistence") response.blockers = [{ kind: "terminal-persistence", count: 1, message: "fixture write" }];
  if (fresh === "unknown") response.blockers = [{ kind: "future-kind", count: 1, message: "fixture unknown" }];
  if (fresh === "changed") response.expiresAtMs += 1;
  if (fresh === "expired") response.expiresAtMs = Date.now() - 1;
  if (fresh === "refused") response = { status: "running" };
  if (fresh === "custody") response = { status: "draining", expiresAtMs: expiry, activeCount: 1, retryAfterMs: 1000,
    blockers: [{ kind: "session-mutation", count: 1, message: "fixture mutation" }], writeCustody: [{ phase: "final-chat-write", count: 1 }] };
  const functions = ["proof_json", "run_gateway_node", "run_gateway", "retain_suspension_cleanup_offer", "request_suspension",
    "prepare_suspension", "check_suspension"].map(ownerFunction).join("\n");
  const originalPoll = ownerFunction("poll_suspension").replace(/^poll_suspension/, "fixture_poll_suspension");
  const program = `set -Eeuo pipefail
unset SECONDS
SECONDS=0
node_bin="$FIXTURE_NODE"
runuser_bin=unused
runtime_home=unused; config_file=unused; state_database=unused; runtime_dir=unused; bus_address=unused
verification_deadline=0; drain_deadline=0; drain_budget=30; drain_poll_interval=25
custody_wait_budget=60; custody_wait_interval=2
held_suspension=""; suspension_expiry=""; suspension_blockers=""
suspension_cleanup_only=0; suspension_handoff_started=0; suspension_prearm_renewal_attempted=0
suspension_scope=system; suspension_pid=123; suspension_generation=456
poll_count=0; last_suspension_prepare=0; interrupt_after_drain="$INTERRUPT"
proof() { "$node_bin" --no-warnings "$FIXTURE_LIB" "$@"; }
fail() { printf '%s\\n' "$*" >&2; return 1; }
sleep() { SECONDS=$((SECONDS + $1)); }
bounded() {
  local budget="$1"; shift
  if [[ "$*" == *'gateway call gateway.suspend.prepare '* ]]; then
    printf '%s' "$PREPARED"
  elif [[ "$*" == *'gateway call gateway.suspend.status '* ]]; then
    printf 'status budget=%s poll=%s\\n' "$budget" "$poll_count" >>"$EVENTS"
    [[ "$*" == *'--params {"suspensionId":"fixture-lease"} --json --timeout 30000' ]] || return 91
    if ((poll_count == 1)); then
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
poll_suspension() {
  local result
  poll_count=$((poll_count + 1))
  if fixture_poll_suspension "$@"; then result=0; else result=$?; fi
  # The first transport consumed the remainder of the graceful deadline.
  if ((poll_count == 1)); then SECONDS="$ELAPSED"; fi
  return "$result"
}
prepare_suspension /fixture
`;
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", program], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C", FIXTURE_NODE: process.execPath,
      OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
      FIXTURE_LIB: join(import.meta.dirname, "release-lib.mjs"), EVENTS: join(root, "events"),
      ELAPSED: String(elapsed), FRESH_EXIT: String(freshExit),
      INTERRUPT: String(interrupt), FIRST_EXIT: String(firstExit), GENERATION_EXIT: String(generation),
      PREPARED: JSON.stringify(prepared), FIRST_PAYLOAD: firstMalformed ? "{}" : "",
      SECOND_PAYLOAD: second ? JSON.stringify(second(expiry)) : "",
      FRESH: fresh === "malformed" ? "{}" : JSON.stringify(response) },
  });
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture (terminal|write|unknown)/);
  const events = readFileSync(join(root, "events"), "utf8").trim().split("\n");
  return { result, events };
}

for (const fresh of ["draining", "ready"]) {
  test(`deadline-cancelled poll requires fresh ${fresh} lease and generation before acceptance`, (t) => {
    const { result, events } = deadlinePoll(t, { fresh });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /SUSPENSION_POLL_FAILED stage=rpc method=gateway.suspend.status exit=124/);
    assert.doesNotMatch(result.stderr, /SUSPENSION_CHECK_FAILED/);
    assert.deepEqual(events, ["status budget=5 poll=1", "status budget=45 poll=2", "generation"]);
    if (fresh === "draining") assert.match(result.stdout, /INTERRUPTING authorized/);
    else assert.doesNotMatch(result.stdout, /INTERRUPTING/);
  });
}
for (const fresh of ["persistence", "unknown", "changed", "expired", "refused", "malformed"]) {
  test(`deadline transition refuses fresh ${fresh} evidence`, (t) => {
    const { result, events } = deadlinePoll(t, { fresh });
    assert.equal(result.status, 75);
    assert.deepEqual(events.slice(0, 2), ["status budget=5 poll=1", "status budget=45 poll=2"]);
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
for (const options of [{ interrupt: 0 }, { elapsed: 29 }, { firstExit: 1 }, { firstExit: 137 },
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
  assert.deepEqual(events, ["status budget=5 poll=1", "status budget=45 poll=2"]);
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
