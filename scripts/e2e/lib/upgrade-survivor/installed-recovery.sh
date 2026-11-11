#!/usr/bin/env bash
set -euo pipefail

harness=/tmp/openclaw-release-harness
artifacts="${OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT:?missing artifact root}"
run_artifacts=""
phase=installed-recovery-setup
capture_failure() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    node "$harness/scripts/e2e/lib/upgrade-survivor/diagnostics.mjs" \
      capture "$artifacts" "$phase" "$status" "" "$run_artifacts" || true
  fi
  exit "$status"
}
# Capture private evidence before the outer Docker owner tears down this cell.
# The host still owns redaction and the only public diagnostic artifact.
trap capture_failure EXIT
source "$harness/scripts/lib/openclaw-e2e-instance.sh"
runtime="/tmp/openclaw-installed-recovery"
mkdir -p "$runtime/tmp" "$runtime/state-tmp" "$runtime/npm-cache" "$artifacts"
run_artifacts="$(node --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  import { openInstalledRecoveryEvidence, startInstalledRecoveryRun } from "/tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs";
  const run = startInstalledRecoveryRun(process.argv[1], process.argv[2]);
  fs.closeSync(openInstalledRecoveryEvidence(path.join(run.directory, "install.log")));
  process.stdout.write(run.directory);
' "$artifacts" "${OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT:-}")"
export TMPDIR="$runtime/tmp" OPENCLAW_TEST_STATE_TMPDIR="$runtime/state-tmp"
export npm_config_prefix="$runtime/npm-prefix" NPM_CONFIG_PREFIX="$runtime/npm-prefix"
export npm_config_cache="$runtime/npm-cache" NPM_CONFIG_CACHE="$runtime/npm-cache"
export npm_config_fund=false npm_config_audit=false npm_config_loglevel=error
export PATH="$npm_config_prefix/bin:$PATH"
export CI=true OPENCLAW_NO_ONBOARD=1 OPENCLAW_NO_PROMPT=1 OPENCLAW_DISABLE_BONJOUR=1
export GATEWAY_AUTH_TOKEN_REF=installed-recovery-fixture-token
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_FUNCTION_B64:?missing test-state function}"
state_home=installed-recovery
if [ "${OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT:-}" = older-runtime ]; then
  # This disposable container installs a native service; its state must belong to
  # the OS account home so the real service-ownership guard remains in force.
  state_home="$(node --input-type=module -e 'import os from "node:os"; process.stdout.write(os.userInfo().homedir);')"
fi
openclaw_test_state_create "$state_home" empty
phase=installed-recovery-install
openclaw_e2e_install_package "$run_artifacts/install.log" "current recovery writer" "$npm_config_prefix"
if [ "${OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT:-}" = older-runtime ]; then
  candidate_prefix="$npm_config_prefix"
  export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$runtime"
  export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$run_artifacts"
  node "$harness/scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs" \
    candidate "$candidate_prefix/lib/node_modules/openclaw" "$OPENCLAW_CURRENT_PACKAGE_TGZ"
  node "$harness/scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs" \
    installed "$candidate_prefix/lib/node_modules/openclaw" "$OPENCLAW_CURRENT_PACKAGE_TGZ"
  export npm_config_prefix="$runtime/published-prefix" NPM_CONFIG_PREFIX="$runtime/published-prefix"
  export PATH="$npm_config_prefix/bin:$PATH"
  phase=older-runtime-install
  openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" \
    npm install -g --prefix "$npm_config_prefix" openclaw@2026.10.9 --no-fund --no-audit \
    >"$run_artifacts/published-install.log" 2>&1
  source "$harness/scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh"
  export ARTIFACT_ROOT="$run_artifacts"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$runtime/gateway.pid"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$run_artifacts/gateway.log"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$run_artifacts/systemctl.log"
  export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON="$run_artifacts/service-install.json"
  export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR="$run_artifacts/service-install.err"
  install_update_restart_systemctl_shim
  write_update_restart_service_auth_env
  phase=older-runtime-configure
  openclaw_e2e_maybe_timeout "$OPENCLAW_E2E_COMMAND_TIMEOUT" openclaw config set gateway \
    "$(cat "$harness/scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json")" --strict-json
  openclaw_e2e_maybe_timeout "$OPENCLAW_E2E_COMMAND_TIMEOUT" openclaw config set plugins.enabled false --strict-json
  phase=older-runtime-gateway
  run_update_restart_probe_gateway install 18789 "$OPENCLAW_E2E_COMMAND_TIMEOUT"
  phase=older-runtime-recovery
  node "$harness/scripts/e2e/lib/upgrade-survivor/older-runtime-recovery.mjs" \
    "$run_artifacts" "$candidate_prefix/lib/node_modules/openclaw" "$npm_config_prefix/lib/node_modules/openclaw" \
    "$OPENCLAW_CURRENT_PACKAGE_TGZ"
  stop_update_restart_probe_gateway "$OPENCLAW_E2E_COMMAND_TIMEOUT"
  exit 0
fi
phase=installed-recovery-configure
openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_COMMAND_TIMEOUT?missing survivor command timeout}" openclaw config set gateway \
  "$(cat "$harness/scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json")" --strict-json
openclaw_e2e_maybe_timeout "$OPENCLAW_E2E_COMMAND_TIMEOUT" openclaw config set plugins.enabled false --strict-json
phase=installed-recovery-command
node "$harness/scripts/e2e/lib/upgrade-survivor/installed-recovery.mjs" \
  "$run_artifacts" "$npm_config_prefix" "$OPENCLAW_CURRENT_PACKAGE_TGZ" "$OPENCLAW_CONFIG_PATH" \
  "$artifacts/installed-recovery.json" "${OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT:-}"
