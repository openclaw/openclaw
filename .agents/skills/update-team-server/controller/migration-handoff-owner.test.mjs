import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { events, makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

const owner = readFileSync(
  process.env.MIGRATION_HANDOFF_TEST_OWNER ?? new URL("./openclaw-release-deploy", import.meta.url),
  "utf8",
);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function shellFunction(name) {
  const match = owner.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `missing maintained owner function ${name}`);
  return match[0];
}
const functions = ["proof_json", "assert_frozen_predecessor", "retain_suspension_cleanup_offer", "request_suspension", "poll_suspension", "check_suspension", "arm_suspension_handoff",
  "renew_suspension_before_handoff", "migration_stop_contract", "migration_record_suspension", "migration_prepare_live", "recover_agent_schema_migration"].map(shellFunction).join("\n\n");

// The maintained fixture supplies actual CLI suspension messages and service-state
// transitions. Execute the complete owner functions, ending before cold backup:
// database/rehearsal admission and elapsed-drain scheduling are separate fixtures.
// This protects shutdown intent/order, not native process extinction or a full migration.
function runBoundary(t, scenario = "always-draining", edge = "agent-19-20", prepareOnly = false, warm = "") {
  const f = makeReleaseFixture(t, scenario);
  const library = join(f.root, "release-lib.mjs");
  // Exercise the checked-in complete artifact closure, not a host installation.
  writeFileSync(library, readFileSync(join(import.meta.dirname, "release-lib.mjs"), "utf8").replace(
    'const suspensionContractPath = "/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs";',
    `const suspensionContractPath = ${JSON.stringify(join(import.meta.dirname, "gateway-suspension-contract.mjs"))};`,
  ));
  const permitBefore = readFileSync(f.permit);
  const guardBefore = readFileSync(f.guard);
  const initialInstance = "stale-peer-instance";
  const program = `set -euo pipefail
node_bin=${quote(process.execPath)}
release_lib=${quote(library)}
state=${quote(f.state)}
serving_root=${quote(f.serving)}
releases_root="$serving_root/releases"
previous_release=${quote(f.initial)}
candidate_release="$releases_root/${"b".repeat(40)}"
current_link="$serving_root/current"
journal_file="$state/migration.json"
permit=${quote(f.permit)}
guard=${quote(f.guard)}
root_uid=${quote(process.getuid())}
runtime_uid=${quote(f.runtimeUid)}
build_budget=2400
systemctl_bin=${quote(f.commandPaths.systemctl)}
proc_root=${quote(join(f.root, "proc"))}
config_file=${quote(f.configPath)}
state_database=${quote(f.databasePath)}
mirror=unused; build_home=unused; runtime_home=unused
held_suspension=""; suspension_instance=${quote(initialInstance)}
suspension_scope=system; suspension_release="$previous_release"
suspension_pid=0; suspension_generation=0; suspension_state=READY
suspension_expiry=0; suspension_blockers=""; migration_evidence='{}'
interrupt_after_drain=1; drain_budget_elapsed=1; predecessor_stopped=0
skip_migration_rehearsal=0; frozen_target_sha=""; suspension_write_custody=unknown
suspension_cleanup_only=0; suspension_handoff_started=0; suspension_prearm_renewal_attempted=0; last_suspension_prepare=0
printf '%s' '{}' >"$journal_file"
event() { printf '%s\\n' "$*" >>${quote(f.eventlog)}; }
fail() { printf '%s\\n' "$*" >&2; return 1; }
run_gateway() { local release="$1"; shift; OPENCLAW_CONFIG_PATH="$config_file" OPENCLAW_STATE_DIR="$(dirname "$(dirname "$state_database")")" "$node_bin" "$release/dist/index.js" "$@"; }
system_systemctl() { "$systemctl_bin" "$@"; }
system_state() { cat "$state/system"; }
read_pointer() { readlink "$1"; }
capture_generation() { service_pid="$(cat "$state/pid")"; service_generation=${quote(f.start)}; }
recheck_generation() {
  [[ "$1" == system && "$2" == "$(cat "$state/pid")" && "$3" == ${quote(f.start)} && "$(system_state)" == active ]]
}
assert_protected_identity() {
  ${warm === "refresh" || warm === "failure" ? '[[ -f "$state/refreshed-proof" ]] || { fail "stale synthetic config binding"; return 1; }' : ":"}
  cmp "$config_file" "$state/config-before"
}
assert_policy() { return 0; }
migration_assert_inputs() { assert_protected_identity && assert_policy; }
migration_check_guard() { [[ -f "$guard" ]]; }
bounded() { shift; "$@"; }
# Stop the fixture at its declared boundary; no Doctor, database copy, or restart follows.
migration_assert_stopped() {
  [[ "$(system_state)" == inactive && ! -e "$permit" ]] || return 1
  event boundary.after-stop
  exit 0
}
proof() {
  local operation="$1"; shift
  case "$operation" in
    suspension-handoff)
      "$node_bin" --no-warnings "$release_lib" "$operation" "$@" || return 1
      event handoff.acknowledgment-validated ;;
    suspension-*) "$node_bin" --no-warnings "$release_lib" "$operation" "$@" ;;
    migration-load) ${warm ? `printf '%s' '{"record":{"phase":"A_PREPARED","agentMigration":{"artifacts":{"preflight":{}}}}}'` : "printf '{}'"} ;;
    validate-release|migration-guard-descriptor) printf '{}' ;;
    migration-live-preflight)
      ${warm === "refresh" ? '[[ -f "$state/strict-preflight" ]] || { fail "lease preceded strict refreshed preflight"; return 1; }' : ":"}
      event migration.live-preflight
      printf '{}' ;;
    migration-rehearsal-inputs)
      event rehearsal.inspected
      printf '%s' '${JSON.stringify({ status: warm === "current" ? "current" : "warm-config-refresh-required" })}' ;;
    migration-rehearse)
      event rehearsal.refresh
      ${warm === "failure" ? 'fail "synthetic copied Doctor failed"; return 1' : 'printf yes >"$state/refreshed-proof"; printf \'{}\''} ;;
    migration-preflight-check)
      [[ -f "$state/refreshed-proof" ]] || return 1
      event rehearsal.strict-current
      printf yes >"$state/strict-preflight"
      printf PREFLIGHT_OK ;;
    policy) printf '{}' ;;
    migration-record-kind) printf '%s' ${quote(edge)} ;;
    migration-record-nocow) printf false ;;
    migration-nocow-summary) return 0 ;;
    migration-status) printf prepared ;;
    journal-field)
      case "$2" in
        predecessor.sha) printf '%s' ${quote(f.sha)} ;;
        candidate.sha) printf '%s' '${"b".repeat(40)}' ;;
        protectedPaths) printf '{}' ;;
        process.pid) printf '%s' ${quote(f.pid)} ;;
        process.generation) printf '%s' ${quote(f.start)} ;;
        *) fail "unexpected journal field: $2" ;;
      esac ;;
    migration-live-check|release-capacity) return 0 ;;
    migration-transition)
      cat >"$state/prepared-transition.json"
      cat "$state/prepared-transition.json" ;;
    migration-permit-revoke)
      event permit.revoked
      rm -f "$permit" ;;
    migration-permit-absent) [[ ! -e "$permit" ]] ;;
    *) fail "unexpected proof command: $operation" ;;
  esac
}
prepare_suspension() {
  local response parsed _terminal_blocked
  suspension_request='{"drain":true,"requestId":"migration-proof-request","terminalPolicy":"preserve"}'
  response="$(run_gateway "$1" gateway call gateway.suspend.prepare --params "$suspension_request" --json --timeout 30000)" || return 1
  parsed="$(proof_json suspension-prepare "$response")" || return 1
  read -r suspension_state held_suspension suspension_expiry suspension_active_count suspension_retry_after_ms _terminal_blocked suspension_blockers suspension_write_custody <<<"$parsed"
}
${functions}
${prepareOnly ? 'migration_prepare_live\nprintf "%s" "$suspension_instance" >"$state/captured-instance"' : "recover_agent_schema_migration"}
`;
  writeFileSync(join(f.state, "config-before"), f.originalConfigBytes);
  const result = spawnSync(f.realCommands.bash, ["-c", program], {
    cwd: f.root, env: f.env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  return { f, result, permitBefore, guardBefore, log: events(f).trim().split("\n") };
}

function remainsRunning(outcome) {
  const { f, result, permitBefore, guardBefore, log } = outcome;
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(readFileSync(join(f.state, "system"), "utf8"), "active");
  assert.equal(readFileSync(join(f.state, "pid"), "utf8"), String(f.pid));
  assert.deepEqual(readFileSync(f.permit), permitBefore);
  assert.deepEqual(readFileSync(f.guard), guardBefore);
  assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  assert.equal(readlinkSync(join(f.serving, "current")), f.initial);
  assert.ok(!log.includes("permit.revoked"));
  assert.ok(!log.includes("service.system.stop"));
  assert.ok(!log.includes("boundary.after-stop"));
}

test("migration preparation binds the fresh Gateway instance for a later handoff", t => {
  const { f, result } = runBoundary(t, "always-draining", "agent-19-20", true);
  assert.equal(result.status, 0, result.stderr);
  const fresh = `fixture-instance-${f.pid}`;
  assert.equal(readFileSync(join(f.state, "captured-instance"), "utf8"), fresh);
  assert.equal(JSON.parse(readFileSync(join(f.state, "prepared-transition.json"))).process.instance, fresh);
});

for (const edge of ["agent-19-20", "agent-20-21", "state-16-17"]) {
  test(`${edge} interruption validates the exact handoff before revoking the permit and stopping`, t => {
    const { f, result, log } = runBoundary(t, "always-draining", edge);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.state, "shutdown-kind"), "utf8"), "external-restart");
    const ordered = ["handoff.armed", "handoff.acknowledgment-validated", "permit.revoked", "service.system.stop", "handoff.consumed", "boundary.after-stop"];
    let last = -1;
    for (const name of ordered) {
      const index = log.indexOf(name);
      assert.ok(index > last, `${name} did not follow ${ordered}\n${log.join("\n")}`);
      last = index;
    }
    assert.equal(log.filter(name => name === "service.system.stop").length, 1);
    assert.equal(existsSync(f.permit), false);
  });
}

for (const scenario of ["handoff-refused", "handoff-uncertain"]) {
  test(`${scenario} preserves the running migration predecessor and start permit`, t => {
    const outcome = runBoundary(t, scenario);
    remainsRunning(outcome);
    assert.ok(outcome.log.includes("gateway gateway call gateway.suspend.handoff"));
    assert.ok(!outcome.log.includes("handoff.acknowledgment-validated"));
  });
}

test("READY migration stops without requiring an interrupt handoff", t => {
  const { f, result, log } = runBoundary(t, "success");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.state, "shutdown-kind"), "utf8"), "stop");
  assert.ok(log.includes("boundary.after-stop"));
  assert.ok(!log.includes("gateway gateway call gateway.suspend.handoff"));
  assert.equal(log.filter(name => name === "service.system.stop").length, 1);
});

test("retained migration refreshes authored config proof before acquiring any suspension", t => {
  const { f, result, log } = runBoundary(t, "always-draining", "state-17-18", false, "refresh");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REHEARSAL_REFRESHED/);
  const ordered = ["rehearsal.inspected", "rehearsal.refresh", "rehearsal.strict-current", "migration.live-preflight",
    "gateway gateway call gateway.suspend.prepare", "handoff.armed", "service.system.stop", "boundary.after-stop"];
  let previous = -1;
  for (const event of ordered) {
    const index = log.indexOf(event);
    assert.ok(index > previous, `${event} did not follow ${ordered}\n${log.join("\n")}`);
    previous = index;
  }
  assert.equal(log.filter(event => event === "rehearsal.refresh").length, 1);
  assert.equal(log.filter(event => event === "service.system.stop").length, 1);
  assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
});

test("a failed warm refresh cannot acquire a suspension or stop the predecessor", t => {
  const outcome = runBoundary(t, "always-draining", "state-17-18", false, "failure");
  remainsRunning(outcome);
  assert.match(outcome.result.stderr, /synthetic copied Doctor failed/);
  assert.ok(outcome.log.includes("rehearsal.refresh"));
  assert.ok(!outcome.log.includes("migration.live-preflight"));
  assert.ok(!outcome.log.includes("gateway gateway call gateway.suspend.prepare"));
});

test("current warm proof reaches the existing handoff without a rehearsal refresh", t => {
  const { result, log } = runBoundary(t, "always-draining", "state-17-18", false, "current");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(log.includes("rehearsal.inspected"));
  assert.ok(log.includes("boundary.after-stop"));
  assert.ok(!log.includes("rehearsal.refresh"));
  assert.doesNotMatch(result.stdout, /REHEARSAL_REFRESHED/);
});
