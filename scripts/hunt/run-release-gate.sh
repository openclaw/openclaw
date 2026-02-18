#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run the OpenClaw per-release hunt gate (prod-observe + optional staging-chaos).

Usage:
  bash scripts/hunt/run-release-gate.sh [options]

Options:
  --release <label>          Release label (default: openclaw-<openclaw --version>)
  --lane <name>              Lane label (default: prod-observe)
  --run-id <id>              Run identifier (default: gate-<utc>)
  --out-dir <path>           Output directory (default: artifacts/hunt/release-gate-<utc>)
  --window-minutes <number>  Log lookback window for snapshots (default: 120)
  --skip-update              Skip update+restart phase
  --skip-tests               Skip unit/e2e quick test bundles
  --skip-chaos               Skip staging chaos phase
  --update-command <cmd>     Override update command (default: openclaw update --no-restart)
  --restart-command <cmd>    Override restart command (default: launchctl bootout gui/$(id -u)/ai.openclaw.gateway || openclaw gateway restart)
  --verify-command <cmd>     Override post-restart verify command (default: openclaw gateway status)
  -h, --help                 Show help
USAGE
}

STAMP_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_LABEL=""
LANE="prod-observe"
RUN_ID="gate-${STAMP_UTC}"
OUT_DIR="artifacts/hunt/release-gate-${STAMP_UTC}"
WINDOW_MINUTES="120"
SKIP_UPDATE="0"
SKIP_TESTS="0"
SKIP_CHAOS="0"
UPDATE_COMMAND="openclaw update --no-restart"
RESTART_COMMAND='launchctl bootout "gui/$(id -u)/${OPENCLAW_LAUNCHAGENT_LABEL:-ai.openclaw.gateway}" || openclaw gateway restart'
VERIFY_COMMAND="openclaw gateway status"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      RELEASE_LABEL="${2:-}"
      shift 2
      ;;
    --lane)
      LANE="${2:-}"
      shift 2
      ;;
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --window-minutes)
      WINDOW_MINUTES="${2:-}"
      shift 2
      ;;
    --skip-update)
      SKIP_UPDATE="1"
      shift
      ;;
    --skip-tests)
      SKIP_TESTS="1"
      shift
      ;;
    --skip-chaos)
      SKIP_CHAOS="1"
      shift
      ;;
    --update-command)
      UPDATE_COMMAND="${2:-}"
      shift 2
      ;;
    --restart-command)
      RESTART_COMMAND="${2:-}"
      shift 2
      ;;
    --verify-command)
      VERIFY_COMMAND="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$RELEASE_LABEL" ]]; then
  DETECTED_VERSION="$(openclaw --version 2>/dev/null || echo "unknown")"
  RELEASE_LABEL="openclaw-${DETECTED_VERSION}"
fi

case "$LANE" in
  prod-observe|staging-chaos)
    ;;
  *)
    echo "Invalid --lane value: $LANE (expected: prod-observe|staging-chaos)" >&2
    exit 1
    ;;
esac

CHECKS_DIR="$OUT_DIR/checks"
KNOWN_ISSUES_DIR="$OUT_DIR/known-issues"
CHAOS_OUT_DIR="$OUT_DIR/staging-chaos"
mkdir -p "$CHECKS_DIR"
mkdir -p "$KNOWN_ISSUES_DIR"

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

write_check_meta() {
  local meta_path="$1"
  CHECK_META_PATH="$meta_path" \
    CHECK_ID="$2" \
    CHECK_TITLE="$3" \
    CHECK_STATUS="$4" \
    CHECK_COMMAND="$5" \
    CHECK_SUMMARY="$6" \
    CHECK_STARTED_AT="$7" \
    CHECK_ENDED_AT="$8" \
    CHECK_DURATION_MS="$9" \
    CHECK_LOG_PATH="${10}" \
    CHECK_EXIT_CODE="${11}" \
    node - <<'NODE'
const fs = require("node:fs");

const logPath = process.env.CHECK_LOG_PATH || "";
const exitCode = Number(process.env.CHECK_EXIT_CODE || "0");

let logExcerpt = "";
if (logPath && fs.existsSync(logPath)) {
  const lines = fs
    .readFileSync(logPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean);
  logExcerpt = lines.slice(-20).join("\n");
}

const evidence = [];
if (process.env.CHECK_COMMAND) {
  evidence.push(`command: ${process.env.CHECK_COMMAND}`);
}
if (logExcerpt) {
  evidence.push(`logExcerpt:\n${logExcerpt}`);
}
evidence.push(`exitCode=${exitCode}`);

const payload = {
  id: process.env.CHECK_ID,
  title: process.env.CHECK_TITLE,
  status: process.env.CHECK_STATUS,
  command: process.env.CHECK_COMMAND || undefined,
  summary: process.env.CHECK_SUMMARY || "",
  startedAt: process.env.CHECK_STARTED_AT,
  endedAt: process.env.CHECK_ENDED_AT,
  durationMs: Number(process.env.CHECK_DURATION_MS || "0"),
  evidence: evidence.length > 0 ? evidence : undefined,
  artifacts: logPath ? [logPath] : [],
  metadata: {
    exitCode,
  },
};

fs.writeFileSync(process.env.CHECK_META_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
NODE
}

record_skip() {
  local id="$1"
  local title="$2"
  local summary="$3"
  local command="${4:-}"
  local started="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local ended="$started"
  local meta_path="$CHECKS_DIR/${id}.json"
  write_check_meta "$meta_path" "$id" "$title" "skip" "$command" "$summary" "$started" "$ended" "0" "" "0"
}

run_check() {
  local id="$1"
  local title="$2"
  local command="$3"
  local policy="$4" # strict|warn

  local started_epoch
  started_epoch="$(node -p 'Date.now()')"
  local started_iso
  started_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local log_path="$CHECKS_DIR/${id}.log"
  local meta_path="$CHECKS_DIR/${id}.json"

  set +e
  bash -lc "$command" >"$log_path" 2>&1
  local exit_code=$?
  set -e

  local ended_epoch
  ended_epoch="$(node -p 'Date.now()')"
  local ended_iso
  ended_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local duration_ms
  duration_ms="$((ended_epoch - started_epoch))"

  local status="pass"
  local summary="command succeeded"
  if [[ "$exit_code" -ne 0 ]]; then
    if [[ "$policy" == "warn" ]]; then
      status="warn"
      summary="command failed but policy=warn"
    else
      status="fail"
      summary="command failed"
    fi
  fi

  write_check_meta "$meta_path" "$id" "$title" "$status" "$command" "$summary" "$started_iso" "$ended_iso" "$duration_ms" "$log_path" "$exit_code"

  echo "[$status] $title"
}

# T0 preflight
run_check \
  "t0_preflight_collect" \
  "T0 preflight runtime snapshot" \
  "bash scripts/hunt/collect-runtime.sh --label preflight --window-minutes ${WINDOW_MINUTES} --output ${OUT_DIR}/preflight-runtime.json" \
  "strict"

run_check \
  "t0_known_issues_baseline" \
  "T0 known issue baseline fetch" \
  "(gh issue view 19788 --repo openclaw/openclaw --json number,title,state,updatedAt,url || true) > ${KNOWN_ISSUES_DIR}/known-issue-19788.json && (gh issue view 19944 --repo openclaw/openclaw --json number,title,state,updatedAt,url || true) > ${KNOWN_ISSUES_DIR}/known-issue-19944.json" \
  "warn"

# T1 update + restart
if [[ "$SKIP_UPDATE" == "1" ]]; then
  record_skip "t1_update" "T1 update --no-restart" "update phase skipped by flag" "$UPDATE_COMMAND"
  record_skip "t1_restart" "T1 restart" "restart phase skipped by flag" "$RESTART_COMMAND"
else
  run_check "t1_update" "T1 update --no-restart" "$UPDATE_COMMAND" "warn"
  run_check "t1_restart" "T1 restart" "$RESTART_COMMAND" "strict"
fi

run_check "t1_post_restart_verify" "T1 post-restart verify" "$VERIFY_COMMAND" "strict"
run_check \
  "t1_post_collect" \
  "T1 post-restart runtime snapshot" \
  "bash scripts/hunt/collect-runtime.sh --label post-restart --window-minutes ${WINDOW_MINUTES} --output ${OUT_DIR}/post-runtime.json" \
  "strict"

# T2 tests
if [[ "$SKIP_TESTS" == "1" ]]; then
  record_skip "t2_unit_bundle" "T2 critical unit bundle" "tests skipped by flag"
  record_skip "t2_e2e_bundle" "T2 critical e2e bundle" "tests skipped by flag"
else
  UNIT_CMD="pnpm vitest run src/daemon/launchd.test.ts src/cli/update-cli/restart-helper.test.ts src/infra/process-respawn.test.ts src/cli/gateway-cli/run-loop.test.ts src/gateway/server-restart-deferral.test.ts src/infra/infra-runtime.test.ts src/infra/heartbeat-wake.test.ts src/slack/monitor/slash.test.ts src/slack/monitor/monitor.test.ts src/slack/monitor/events/interactions.test.ts src/slack/monitor.test.ts src/imessage/monitor.shutdown.unhandled-rejection.test.ts src/imessage/monitor.gating.test.ts src/commands/doctor-gateway-services.test.ts src/commands/doctor-memory-search.test.ts"
  E2E_CMD="pnpm vitest run --config vitest.e2e.config.ts src/commands/doctor-platform-notes.launchctl-env-overrides.e2e.test.ts src/cli/gateway-cli.coverage.e2e.test.ts src/config/config.legacy-config-detection.accepts-imessage-dmpolicy.e2e.test.ts"
  run_check "t2_unit_bundle" "T2 critical unit bundle" "$UNIT_CMD" "strict"
  run_check "t2_e2e_bundle" "T2 critical e2e bundle" "$E2E_CMD" "strict"
fi

# T3 staging chaos
if [[ "$SKIP_CHAOS" == "1" ]]; then
  record_skip "t3_staging_chaos" "T3 staging chaos matrix" "staging chaos skipped by flag"
else
  run_check \
    "t3_staging_chaos" \
    "T3 staging chaos matrix" \
    "bash scripts/hunt/staging-chaos.sh --out-dir ${CHAOS_OUT_DIR} --release ${RELEASE_LABEL} --run-id ${RUN_ID}-chaos --port 19789" \
    "warn"
fi

# Build report input from collected artifacts.
export HUNT_RELEASE_LABEL="$RELEASE_LABEL"
export HUNT_RUN_ID="$RUN_ID"
export HUNT_LANE="$LANE"
export HUNT_STARTED_AT="$STARTED_AT"
export HUNT_OUT_DIR="$OUT_DIR"
export HUNT_WINDOW_MINUTES="$WINDOW_MINUTES"

node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const outDir = process.env.HUNT_OUT_DIR;
const checksDir = path.join(outDir, "checks");
const prePath = path.join(outDir, "preflight-runtime.json");
const postPath = path.join(outDir, "post-runtime.json");
const chaosPath = path.join(outDir, "staging-chaos", "report-input.json");

const checkFiles = fs.existsSync(checksDir)
  ? fs
      .readdirSync(checksDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(checksDir, name))
      .sort()
  : [];

const checks = checkFiles
  .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf-8")))
  .filter(
    (check) =>
      check &&
      typeof check === "object" &&
      typeof check.id === "string" &&
      typeof check.title === "string" &&
      typeof check.status === "string",
  );

if (fs.existsSync(chaosPath)) {
  const chaosReport = JSON.parse(fs.readFileSync(chaosPath, "utf-8"));
  for (const check of chaosReport.checks || []) {
    checks.push({
      ...check,
      id: `chaos_${check.id}`,
      title: `[chaos] ${check.title}`,
    });
  }
}

const pre = fs.existsSync(prePath) ? JSON.parse(fs.readFileSync(prePath, "utf-8")) : null;
const post = fs.existsSync(postPath) ? JSON.parse(fs.readFileSync(postPath, "utf-8")) : null;

const preByKey = new Map();
for (const sig of pre?.signatures || []) {
  preByKey.set(`${sig.name}:${sig.source}`, sig);
}

const issueMap = {
  slack_listeners_crash: "https://github.com/openclaw/openclaw/issues/19788",
  memory_module_not_available: "https://github.com/openclaw/openclaw/issues/19944",
  memory_module_unavailable: "https://github.com/openclaw/openclaw/issues/19944",
};

const baselineReference = {
  capturedAt: "2026-02-18T10:03:53Z",
  counts: {
    slack_listeners_crash: 98,
    memory_module_not_available: 72,
    memory_module_unavailable: 72,
    extraction_llm_unavailable: 26,
    config_invalid: 0,
  },
};

const signatureAllowlist = new Set([
  "slack_listeners_crash",
  "memory_module_not_available",
  "memory_module_unavailable",
  "extraction_llm_unavailable",
  "recovery_budget_exceeded",
  "gateway_already_running",
  "err_pnpm_no_global_bin_dir",
  "suppressed_abort_error",
  "orphaned_user_message_removed",
  "token_missing",
]);

const signatures = (post?.signatures || []).map((sig) => {
  const key = `${sig.name}:${sig.source}`;
  const baseline = preByKey.get(key);
  const baselineFallback = Number(baselineReference.counts[sig.name] ?? 0);
  const baselineWindowCount = Number(baseline?.countWindow ?? baselineFallback);
  const countWindow = Number(sig.countWindow || 0);
  const delta = countWindow - baselineWindowCount;
  return {
    name: sig.name,
    source: sig.source,
    countWindow,
    countTotal: Number(sig.countTotal || 0),
    windowMinutes: Number(sig.windowMinutes || Number(process.env.HUNT_WINDOW_MINUTES || "120")),
    baselineWindowCount,
    delta,
    issueUrl: issueMap[sig.name],
  };
});

const classification = [];

for (const sig of signatures) {
  if (sig.countWindow <= 0) {
    continue;
  }

  if (sig.name === "config_invalid" || sig.name === "config_schema_additional_properties") {
    classification.push({
      id: `signature_${sig.name}`,
      category: "core",
      severity: "p0",
      status: "new",
      summary: `${sig.name} seen in current window (${sig.countWindow})`,
      expected: "no config validation hard errors after release update",
      actual: `signature ${sig.name} detected`,
      suggestedFix: "reproduce with failing config and add doctor migration/fix coverage",
    });
    continue;
  }

  if (issueMap[sig.name]) {
    classification.push({
      id: `signature_${sig.name}`,
      category: "core",
      severity: "p1",
      status: sig.delta > 0 ? "regressed" : "known",
      summary: `${sig.name} countWindow=${sig.countWindow}, baseline=${sig.baselineWindowCount}, delta=${sig.delta}`,
      issueUrl: issueMap[sig.name],
      expected: "known issue count should trend down or remain stable",
      actual: `observed ${sig.countWindow} events in release gate window`,
      suggestedFix: "link to upstream issue/PR and keep release allowlist until fixed",
    });
    continue;
  }

  if (!signatureAllowlist.has(sig.name)) {
    classification.push({
      id: `signature_${sig.name}`,
      category: "core",
      severity: "p0",
      status: "new",
      summary: `new non-allowlisted signature: ${sig.name} (${sig.countWindow})`,
      expected: "no new crash/error signature without triage",
      actual: `non-allowlisted signature ${sig.name} detected`,
      suggestedFix: "open issue + repro + regression test before next release",
    });
  }
}

const failedChecks = checks.filter((check) => check.status === "fail");
if (failedChecks.length > 0) {
  classification.push({
    id: "release_gate_failed_checks",
    category: "ops",
    severity: "p0",
    status: "new",
    summary: `${failedChecks.length} release-gate checks failed`,
    expected: "all strict gate checks should pass",
    actual: failedChecks.map((check) => check.id).join(", "),
    suggestedFix: "inspect failed check logs, reproduce, and patch before promoting release",
  });
}

if (fs.existsSync(chaosPath)) {
  const chaosReport = JSON.parse(fs.readFileSync(chaosPath, "utf-8"));
  for (const entry of chaosReport.classification || []) {
    classification.push({
      ...entry,
      id: `chaos_${entry.id}`,
    });
  }
}

const upstreamLinks = Array.from(
  new Set(
    [
      "https://github.com/openclaw/openclaw/issues/19788",
      "https://github.com/openclaw/openclaw/issues/19944",
      ...classification.map((entry) => entry.issueUrl).filter(Boolean),
      ...classification.map((entry) => entry.prUrl).filter(Boolean),
    ].filter(Boolean),
  ),
);

const reportInput = {
  version: "1",
  release: process.env.HUNT_RELEASE_LABEL || "unknown",
  runId: process.env.HUNT_RUN_ID || `gate-${Date.now()}`,
  lane: process.env.HUNT_LANE || "prod-observe",
  startedAt: process.env.HUNT_STARTED_AT || new Date().toISOString(),
  endedAt: new Date().toISOString(),
  checks,
  signatures,
  classification,
  upstreamLinks,
  metadata: {
    outDir,
    preflightSnapshot: fs.existsSync(prePath) ? prePath : null,
    postSnapshot: fs.existsSync(postPath) ? postPath : null,
    chaosSnapshot: fs.existsSync(chaosPath) ? chaosPath : null,
    windowMinutes: Number(process.env.HUNT_WINDOW_MINUTES || "120"),
    baselineReference,
  },
};

fs.writeFileSync(path.join(outDir, "report-input.json"), `${JSON.stringify(reportInput, null, 2)}\n`, "utf-8");

const hasP0 = classification.some((entry) => entry.severity === "p0" && (entry.status === "new" || entry.status === "regressed"));
const hasFailChecks = checks.some((check) => check.status === "fail");
const gateStatus = hasFailChecks || hasP0 ? "fail" : classification.length > 0 ? "warn" : "pass";
fs.writeFileSync(path.join(outDir, "gate-status.txt"), `${gateStatus}\n`, "utf-8");

console.log(`Wrote gate input: ${path.join(outDir, "report-input.json")}`);
console.log(`Gate status: ${gateStatus}`);
NODE

node --import tsx scripts/hunt/render-report.ts \
  --input "$OUT_DIR/report-input.json" \
  --json-out "$OUT_DIR/hunt-report.json" \
  --md-out "$OUT_DIR/hunt-report.md"

GATE_STATUS="$(cat "$OUT_DIR/gate-status.txt" | tr -d '[:space:]')"
echo "Release gate completed: status=${GATE_STATUS} out=${OUT_DIR}"

if [[ "$GATE_STATUS" == "fail" ]]; then
  exit 1
fi
