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
openclaw_test_state_create installed-recovery empty
phase=installed-recovery-install
openclaw_e2e_install_package "$run_artifacts/install.log" "current recovery writer" "$npm_config_prefix"
phase=installed-recovery-configure
openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_COMMAND_TIMEOUT?missing survivor command timeout}" openclaw config set gateway \
  "$(cat "$harness/scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json")" --strict-json
openclaw_e2e_maybe_timeout "$OPENCLAW_E2E_COMMAND_TIMEOUT" openclaw config set plugins.enabled false --strict-json
phase=installed-recovery-command
node "$harness/scripts/e2e/lib/upgrade-survivor/installed-recovery.mjs" \
  "$run_artifacts" "$npm_config_prefix" "$OPENCLAW_CURRENT_PACKAGE_TGZ" "$OPENCLAW_CONFIG_PATH" \
  "$artifacts/installed-recovery.json" "${OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT:-}"
