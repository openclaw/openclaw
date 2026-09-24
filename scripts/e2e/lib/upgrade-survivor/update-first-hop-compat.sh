#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh
source scripts/lib/docker-e2e-logs.sh

if [ "${OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP:-0}" != "1" ]; then
  echo "blocked destructive package self-update; set OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 to run" >&2
  exit 2
fi

SOURCE_PACKAGE=/tmp/openclaw-update-first-hop-source.tgz
CANDIDATE_PACKAGE=/tmp/openclaw-update-first-hop-candidate.tgz
ORIGINAL_CANDIDATE_PACKAGE=/tmp/openclaw-update-first-hop-original.tgz
NEGATIVE_PACKAGE=/tmp/openclaw-update-first-hop-negative.tgz
FUTURE_PACKAGE=/tmp/openclaw-update-first-hop-future.tgz
UNSUPPORTED_ADMISSION_PACKAGE=/tmp/openclaw-update-first-hop-unsupported-admission.tgz
ARTIFACT_DIR="${OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR:-/tmp/openclaw-update-first-hop-artifacts}"
EXPECTED_MISSING_CHUNK="${OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK-}"
ADMISSION_PROTOCOL="${OPENCLAW_UPDATE_FIRST_HOP_ADMISSION_PROTOCOL-}"
BASE_PATH="$PATH"
ACCOUNT_HOME="$HOME"
mock_pid=""
trap 'openclaw_e2e_stop_process "${mock_pid:-}"' EXIT

export CI=true
export OPENCLAW_ALLOW_ROOT=1
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1
export OPENCLAW_SKIP_PROVIDERS=1
export npm_config_audit=false
export npm_config_fund=false
export npm_config_loglevel=error

for package_path in "$SOURCE_PACKAGE" "$CANDIDATE_PACKAGE" "$ORIGINAL_CANDIDATE_PACKAGE" "$NEGATIVE_PACKAGE" "$FUTURE_PACKAGE" "$ARTIFACT_DIR/source.json"; do
  if [ ! -f "$package_path" ]; then
    echo "missing package input: $package_path" >&2
    exit 2
  fi
done
mkdir -p "$ARTIFACT_DIR"
source_version="$(tar -xOf "$SOURCE_PACKAGE" package/package.json | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')"
candidate_source_version="$(tar -xOf "$ORIGINAL_CANDIDATE_PACKAGE" package/package.json | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')"

package_root() {
  printf '%s/lib/node_modules/openclaw\n' "$npm_config_prefix"
}

run_update() {
  local output="$ARTIFACT_DIR/$1" target="$2" update_status=0
  cp "$(package_root)/package.json" "$output-source-package.json"
  printf '%q ' env "PATH=$PATH" "npm_config_prefix=$npm_config_prefix" openclaw \
    update --yes "--tag=$target" --json >"$output-command.txt"
  printf '\n' >>"$output-command.txt"
  openclaw update --yes "--tag=$target" --json \
    >"$output.stdout" 2>"$output.stderr" || update_status="$?"
  printf '%s\n' "$update_status" >"$output.exit"
  if [ "$update_status" -ne 0 ]; then
    echo "package update $1 exited with status $update_status" >&2
    docker_e2e_print_log "$output.stdout" >&2
    docker_e2e_print_log "$output.stderr" >&2
  fi
  return "$update_status"
}

assert_admission() {
  local output="$ARTIFACT_DIR/$1" owner="$2" warning="${3:-}"
  node - "$output" "$owner" "$warning" <<'ADMISSION'
const assert = require("node:assert/strict"), fs = require("node:fs");
const [output, owner, warning] = process.argv.slice(2);
const raw = fs.readFileSync(`${output}.stdout`, "utf8");
const result = JSON.parse(raw.slice(raw.indexOf("{")));
const source = JSON.parse(fs.readFileSync(`${output}-source-package.json`, "utf8"));
assert.equal(source.openclaw?.updateAdmissionProtocol, 1, "Source must support candidate admission");
assert.equal(result.status, "ok");
assert.equal(result.run?.admission?.owner, owner);
const verdict = result.run.origin?.candidateAdmission;
if (owner === "candidate") {
  assert.equal(result.run.admission.protocol, 1);
  assert.equal(verdict?.protocol, 1);
  assert.equal(verdict.verdict, "admit");
  assert.deepEqual(verdict.reasons, []);
  assert.equal(result.run.admission.candidateVersion, verdict.facts.candidateVersion);
  assert.deepEqual(result.run.admission.checks, verdict.facts.checks);
  assert(result.run.steps.some(step => step.step === "candidate-admission"));
  if (warning) {
    assert(verdict.warnings.some(entry => entry.code === warning), `Missing candidate warning ${warning}`);
    assert(verdict.facts.checks.some(check => check.status === "warn"), "Candidate checks omitted warning status");
  }
} else {
  assert.equal(verdict, undefined, "Unsupported target must not execute candidate admission");
  assert.equal(warning, "update-admission-unsupported-target");
  assert.equal(result.run.steps.filter(step => step.step === `warning:${warning}`).length, 1);
}
fs.writeFileSync(`${output}-admission.json`, `${JSON.stringify({ status: result.status, admission: result.run.admission, verdict }, null, 2)}\n`);
ADMISSION
}

record_residue() {
  local output="$1"
  find "$npm_config_prefix/lib/node_modules" -maxdepth 2 \
    \( -name '.openclaw-update-*' -o -name '.openclaw.update-stage-*' \
      -o -name '.openclaw.package-backup-*' -o -name 'openclaw.backup-*' -o -name '*.rollback-*' \) \
    -print | sort >"$output"
}

assert_no_residue() {
  local file="$1"
  if [ -s "$file" ]; then
    echo "update left transaction residue" >&2
    cat "$file" >&2
    return 1
  fi
}

wait_service_active() {
  for _ in $(seq 1 300); do
    if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "managed service did not become active" >&2
  return 1
}

record_service_state() {
  local output="$1"
  systemctl --user show \
    --property=Id,LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent \
    openclaw-gateway.service >"$output"
}

assert_installed_build() {
  local expected_package="$1" output="$2"
  tar -xOf "$expected_package" package/dist/build-info.json \
    >"$output.expected" 2>"$output.tar.stderr"
  cp "$(package_root)/dist/build-info.json" "$output"
  if ! cmp -s "$output.expected" "$output"; then
    echo "installed package build did not match selected candidate" >&2
    diff -u "$output.expected" "$output" >&2 || true
    return 1
  fi
}

setup_lane() {
  local lane="$1" port="$2" source_package="${3:-$SOURCE_PACKAGE}" missing_path="${4:-0}"
  local runtime_root="/tmp/openclaw-update-first-hop-runtime/$lane"
  export HOME="$ACCOUNT_HOME"
  export OPENCLAW_STATE_DIR="$HOME/.openclaw"
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  export npm_config_prefix="$runtime_root/npm-prefix"
  export NPM_CONFIG_PREFIX="$npm_config_prefix"
  export npm_config_cache="$runtime_root/npm-cache"
  export NPM_CONFIG_CACHE="$npm_config_cache"
  export PATH="$npm_config_prefix/bin:$BASE_PATH"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$ARTIFACT_DIR/$lane-systemctl.log"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_DIR/$lane-systemctl.pid"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$ARTIFACT_DIR/$lane-gateway.log"

  mkdir -p "$OPENCLAW_STATE_DIR" "$npm_config_prefix" "$npm_config_cache"
  npm install -g --prefix "$npm_config_prefix" "$source_package" --no-fund --no-audit \
    >"$ARTIFACT_DIR/$lane-install-source.log" 2>&1 || {
      docker_e2e_print_log "$ARTIFACT_DIR/$lane-install-source.log" >&2
      return 1
    }
  openclaw --version >"$ARTIFACT_DIR/$lane-source-version.txt"
  assert_installed_build "$source_package" "$ARTIFACT_DIR/$lane-source-build-info.json"
  install_update_restart_systemctl_shim
  openclaw config set gateway.mode local >"$ARTIFACT_DIR/$lane-config.log" 2>&1
  openclaw config set gateway.port "$port" >>"$ARTIFACT_DIR/$lane-config.log" 2>&1
  openclaw config set gateway.reload.mode off >>"$ARTIFACT_DIR/$lane-config.log" 2>&1
  case "$source_version" in
    2026.9.2 | 2026.9.3)
      node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai 44212
      ;;
  esac
  if [ "$missing_path" = "1" ]; then
    export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$runtime_root"
    export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_DIR/$lane"
    node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai 44212
    node - "$OPENCLAW_CONFIG_PATH" <<'PLUGIN_CONFIG'
const fs = require("node:fs"), file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.plugins.allow ??= [];
config.plugins.entries ??= {};
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
PLUGIN_CONFIG
    node scripts/e2e/lib/upgrade-survivor/missing-load-path.mjs missing-load-path seed
  fi
  openclaw gateway install --force --json \
    >"$ARTIFACT_DIR/$lane-service-install.json" \
    2>"$ARTIFACT_DIR/$lane-service-install.err"
  wait_service_active
  cp "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE" "$ARTIFACT_DIR/$lane-before.pid"
  record_service_state "$ARTIFACT_DIR/$lane-service-before.txt"
  if [ "$missing_path" = "1" ]; then
    openclaw_e2e_wait_gateway_ready \
      "$(cat "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE")" \
      "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG" 300 "$port"
    node scripts/e2e/lib/upgrade-survivor/missing-load-path.mjs missing-load-path unavailable
  fi
}

stop_lane() {
  systemctl --user stop openclaw-gateway.service >/dev/null 2>&1 || true
}

reset_lane() {
  local lane="${1:-negative}"
  openclaw gateway uninstall --json \
    >"$ARTIFACT_DIR/$lane-service-uninstall.json" \
    2>"$ARTIFACT_DIR/$lane-service-uninstall.err" || true
  rm -rf \
    "$HOME/.openclaw" \
    "$HOME/.config/systemd/user/openclaw-gateway.service" \
    "$HOME/.config/systemd/user/default.target.wants/openclaw-gateway.service"
}

run_negative_control() {
  local lane=negative
  setup_lane "$lane" 18791
  local update_status=0
  run_update "$lane-update" "$NEGATIVE_PACKAGE" || update_status="$?"
  assert_installed_build "$CANDIDATE_PACKAGE" "$ARTIFACT_DIR/$lane-installed-build-info.json"
  record_residue "$ARTIFACT_DIR/$lane-transaction-residue.txt"
  assert_no_residue "$ARTIFACT_DIR/$lane-transaction-residue.txt"

  if [ "$update_status" -ne 1 ]; then
    echo "negative control expected update exit 1, got $update_status" >&2
    return 1
  fi
  if ! grep -Fq "$EXPECTED_MISSING_CHUNK" \
    "$ARTIFACT_DIR/$lane-update.stdout" "$ARTIFACT_DIR/$lane-update.stderr"; then
    echo "negative control did not reproduce missing $EXPECTED_MISSING_CHUNK" >&2
    return 1
  fi
  if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1; then
    echo "negative control unexpectedly preserved the stopped service" >&2
    return 1
  fi
  record_service_state "$ARTIFACT_DIR/$lane-service-after.txt" || true
  stop_lane
  reset_lane
}

run_positive_hops() {
  local lane=positive
  setup_lane "$lane" 18792
  local first_pid
  first_pid="$(cat "$ARTIFACT_DIR/$lane-before.pid")"

  run_update "$lane-first" "$CANDIDATE_PACKAGE"
  assert_installed_build "$CANDIDATE_PACKAGE" "$ARTIFACT_DIR/$lane-first-build-info.json"
  if [ "$candidate_source_version" = "2026.9.3" ]; then
    node scripts/e2e/lib/external-package-transition.mjs schema 16 \
      >"$ARTIFACT_DIR/$lane-first-shared-schema.json"
  fi
  wait_service_active
  local candidate_pid
  candidate_pid="$(cat "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE")"
  if [ "$candidate_pid" = "$first_pid" ]; then
    echo "first hop did not replace the managed service process" >&2
    return 1
  fi
  if grep -Eq 'ERR_MODULE_NOT_FOUND|Cannot find module' \
    "$ARTIFACT_DIR/$lane-first.stdout" "$ARTIFACT_DIR/$lane-first.stderr"; then
    echo "first hop reported a missing runtime import" >&2
    return 1
  fi
  record_residue "$ARTIFACT_DIR/$lane-first-transaction-residue.txt"
  assert_no_residue "$ARTIFACT_DIR/$lane-first-transaction-residue.txt"
  record_service_state "$ARTIFACT_DIR/$lane-service-after-first.txt"
  node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai 44212

  run_update "$lane-second" "$FUTURE_PACKAGE"
  if [ "$ADMISSION_PROTOCOL" = "1" ]; then
    assert_admission "$lane-second" candidate
  fi
  assert_installed_build "$FUTURE_PACKAGE" "$ARTIFACT_DIR/$lane-second-build-info.json"
  wait_service_active
  local future_pid
  future_pid="$(cat "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE")"
  if [ "$future_pid" = "$candidate_pid" ]; then
    echo "second hop did not replace the managed service process" >&2
    return 1
  fi
  if grep -Eq 'ERR_MODULE_NOT_FOUND|Cannot find module' \
    "$ARTIFACT_DIR/$lane-second.stdout" "$ARTIFACT_DIR/$lane-second.stderr"; then
    echo "second hop reported a missing runtime import" >&2
    return 1
  fi
  record_residue "$ARTIFACT_DIR/$lane-second-transaction-residue.txt"
  assert_no_residue "$ARTIFACT_DIR/$lane-second-transaction-residue.txt"
  record_service_state "$ARTIFACT_DIR/$lane-service-after-second.txt"
  printf '%s\n' "$first_pid" "$candidate_pid" "$future_pid" \
    >"$ARTIFACT_DIR/$lane-service-pids.txt"
  if [ "$ADMISSION_PROTOCOL" = "1" ]; then
    run_update "$lane-unsupported-admission" "$UNSUPPORTED_ADMISSION_PACKAGE"
    assert_admission "$lane-unsupported-admission" installed update-admission-unsupported-target
    assert_installed_build "$UNSUPPORTED_ADMISSION_PACKAGE" "$ARTIFACT_DIR/$lane-unsupported-admission-build-info.json"
    wait_service_active
    local unsupported_pid
    unsupported_pid="$(cat "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE")"
    if [ "$unsupported_pid" = "$future_pid" ]; then
      echo "unsupported-admission hop did not replace the managed service process" >&2
      return 1
    fi
    record_residue "$ARTIFACT_DIR/$lane-unsupported-admission-transaction-residue.txt"
    assert_no_residue "$ARTIFACT_DIR/$lane-unsupported-admission-transaction-residue.txt"
    record_service_state "$ARTIFACT_DIR/$lane-service-after-unsupported-admission.txt"
  fi
  stop_lane
}

run_missing_path_admission() {
  local lane=admission-missing-load-path
  reset_lane positive
  setup_lane "$lane" 18793 "$CANDIDATE_PACKAGE" 1
  run_update "$lane-update" "$FUTURE_PACKAGE"
  assert_admission "$lane-update" candidate configured-plugin-path-unavailable
  assert_installed_build "$FUTURE_PACKAGE" "$ARTIFACT_DIR/$lane-build-info.json"
  cp "$ARTIFACT_DIR/$lane-update.stdout" "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json"
  node scripts/e2e/lib/upgrade-survivor/missing-load-path.mjs missing-load-path post-update
  wait_service_active
  openclaw_e2e_wait_gateway_ready \
    "$(cat "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE")" \
    "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG" 300 18793
  stop_lane
  openclaw doctor --fix --non-interactive \
    >"$ARTIFACT_DIR/$lane-doctor.log" 2>&1
  local lint_exit=0
  openclaw doctor --lint --json --severity-min warning \
    --only core/doctor/final-config-validation \
    >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/missing-load-path/doctor-lint.json" \
    2>"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/missing-load-path/doctor-lint.err" || lint_exit=$?
  [ "$lint_exit" -eq 1 ]
  node scripts/e2e/lib/upgrade-survivor/missing-load-path.mjs missing-load-path post-doctor
  node scripts/e2e/lib/upgrade-survivor/update-admission-entry-probe.mjs \
    "$(package_root)" "$ARTIFACT_DIR/$lane-entry-probe.json"
  record_residue "$ARTIFACT_DIR/$lane-transaction-residue.txt"
  assert_no_residue "$ARTIFACT_DIR/$lane-transaction-residue.txt"
  stop_lane
}

export OPENAI_API_KEY="sk-openclaw-first-hop"
export MOCK_REQUEST_LOG="$ARTIFACT_DIR/openai-requests.jsonl"
mock_pid="$(openclaw_e2e_start_mock_openai 44212 "$ARTIFACT_DIR/mock-openai.log")"
openclaw_e2e_wait_mock_openai 44212
if [ -n "$EXPECTED_MISSING_CHUNK" ]; then
  run_negative_control
else
  echo "No deterministic missing-chunk restart control for $source_version; positive hops remain required."
fi
run_positive_hops
if [ "$ADMISSION_PROTOCOL" = "1" ]; then
  run_missing_path_admission
fi

node -e '
  const fs = require("node:fs"), path = require("node:path");
  const root = process.argv[1];
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const source = read("source.json");
  const [sourcePid, candidatePid, futurePid] = fs.readFileSync(path.join(root, "positive-service-pids.txt"), "utf8").trim().split("\n").map(Number);
  fs.writeFileSync(path.join(root, "summary.json"), `${JSON.stringify({
    source,
    negativeControl: source.expectedMissingChunk
      ? { status: "passed", exit: 1, missingChunk: source.expectedMissingChunk }
      : source.negativeControl,
    firstHop: { exit: 0, method: "in-process-self-update", selfUpdatePassed: true, serviceIntent: "active", residueCount: 0, build: read("positive-first-build-info.json"), beforePid: sourcePid, afterPid: candidatePid },
    secondHop: { exit: 0, method: "in-process-self-update", legacyCompatibilityChunksPresent: false, serviceIntent: "active", residueCount: 0, build: read("positive-second-build-info.json"), beforePid: candidatePid, afterPid: futurePid },
    admission: process.env.OPENCLAW_UPDATE_FIRST_HOP_ADMISSION_PROTOCOL === "1" ? {
      supportedTarget: read("positive-second-admission.json"),
      unsupportedTarget: read("positive-unsupported-admission-admission.json"),
      missingLoadPath: {
        ...read("admission-missing-load-path-update-admission.json"),
        postDoctor: read("admission-missing-load-path/missing-load-path/post-doctor.json"),
        pendingLifecycleEntry: read("admission-missing-load-path-entry-probe.json"),
        sameHopPolicyOverrideDemonstrated: false,
      },
    } : { status: "not-supported-by-candidate" },
  }, null, 2)}\n`);
' "$ARTIFACT_DIR"

echo "Packaged updater first-hop compatibility E2E passed."
