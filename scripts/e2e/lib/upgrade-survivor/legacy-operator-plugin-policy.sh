#!/usr/bin/env bash

# The separate prefix tests restrictive plugin policy while the main scenario
# retains its provider-backed turns.
legacy_operator_plugin_policy() (
  trap - EXIT ERR HUP INT TERM
  local mode="$1" source_artifacts="$ARTIFACT_ROOT" source_prefix="$npm_config_prefix"
  local probe="$RUNTIME_ROOT/webhooks-only-policy" seeded
  if [ "$mode" = "capture" ]; then
    rm -f "$source_artifacts/webhooks-only-policy/result.json"
  fi
  # This regression cell uses the published 9.2 driver. Other historical cells
  # retain their own migration specimens and lifecycle assertions.
  [ "$baseline_version" = "2026.9.2" ] || return 0
  # The outer Discord fixture must not install its plugin into this isolated state.
  unset DISCORD_BOT_TOKEN
  seeded="$(node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1])).seeded; if(typeof value!=="boolean") throw new Error("missing Webhooks seed evidence"); console.log(value)' \
    "$source_artifacts/legacy-operator-webhooks.json")" || return "$?"
  [ "$seeded" = true ] || { echo "The 9.2 sole-policy specimen was not seeded" >&2; return 1; }
  if [ "$mode" = "capture" ]; then
    mkdir -p "$probe"
    # Retain the whole installation so package- and prefix-level dependencies
    # still resolve after the primary scenario replaces its own published driver.
    cp -a "$source_prefix" "$probe/npm-prefix"
  fi
  ARTIFACT_ROOT="$source_artifacts/webhooks-only-policy"
  mkdir -p "$ARTIFACT_ROOT" "$probe/home" "$probe/state"
  export HOME="$probe/home" USERPROFILE="$probe/home" OPENCLAW_HOME="$probe/home"
  export OPENCLAW_STATE_DIR="$probe/state" OPENCLAW_CONFIG_PATH="$probe/state/openclaw.json"
  export OPENCLAW_TEST_WORKSPACE_DIR="$probe/state/workspace" OPENCLAW_GATEWAY_PORT=18789
  unset OPENCLAW_PROFILE OPENCLAW_AGENT_DIR PI_CODING_AGENT_DIR
  export npm_config_prefix="$probe/npm-prefix" NPM_CONFIG_PREFIX="$probe/npm-prefix"
  export PATH="$npm_config_prefix/bin:$PATH"
  export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
  BASELINE_PACKAGE_ROOT="$npm_config_prefix/lib/node_modules/openclaw"
  UPDATE_JSON="$ARTIFACT_ROOT/update.json"
  UPDATE_ERR="$ARTIFACT_ROOT/update.err"
  POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/post-update-validate.json"
  POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/post-update-validate.err"
  GATEWAY_LOG="$ARTIFACT_ROOT/gateway.log"
  SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_ROOT/systemctl-shim.pid"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
  gateway_pid=""
  UPDATE_RESTART_MODE=manual
  update_repair_required=0
  initial_update_observation_root=""
  trap stop_gateway EXIT
  if [ "$mode" = "capture" ]; then
    node scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs \
      seed "$source_artifacts" "$baseline_version"
    return
  fi
  [ "$mode" = "verify" ] || { echo "Unknown plugin-policy proof mode" >&2; return 1; }
  [ "$(read_installed_version)" = "$baseline_version" ] || {
    echo "Isolated policy driver is no longer the published baseline" >&2
    return 1
  }
  node scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs driver "$baseline_version"
  GATEWAY_LOG="$ARTIFACT_ROOT/baseline-gateway.log"
  start_gateway
  node scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs baseline "$baseline_version"
  stop_gateway
  update_candidate
  [ "$update_outcome" = "success" ] && [ "$update_repair_required" = "0" ] || {
    echo "Sole-plugin policy update required additional repair" >&2
    return 1
  }
  node scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs post-update "$candidate_version"
  GATEWAY_LOG="$ARTIFACT_ROOT/gateway.log"
  start_gateway
  node scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs live "$candidate_version"
  stop_gateway
)
