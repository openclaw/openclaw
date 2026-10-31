#!/usr/bin/env bash

native_plugin_ui_upgrade_enabled() {
  [ "$SCENARIO" = "legacy-operator-state" ] &&
    { [ "$baseline_version" = "2026.10.5" ] || [ "$baseline_version" = "2026.10.7" ] || [ "$baseline_version" = "2026.10.8" ]; } &&
    [ "$UPDATE_RESTART_MODE" = "manual" ] && [ "$CANDIDATE_KIND" = "tarball" ]
}

pack_native_plugin_ui_fixture() {
  native_plugin_ui_upgrade_enabled || return 0
  local fixture="$RUNTIME_ROOT/native-ui-fixture" packed
  node scripts/e2e/lib/upgrade-survivor/native-plugin-ui.mjs fixture "$fixture"
  packed="$(npm pack "$fixture" --ignore-scripts --pack-destination "$ARTIFACT_ROOT" --silent)" || return "$?"
  mv "$ARTIFACT_ROOT/$packed" "$ARTIFACT_ROOT/native-ui-fixture.tgz"
}

prepare_native_plugin_ui_upgrade() {
  native_plugin_ui_upgrade_enabled || return 0
  openclaw_e2e_fixture_plugin_command openclaw -- plugins install openclaw-survivor-native-ui@1.0.0 --force
  node scripts/e2e/lib/upgrade-survivor/native-plugin-ui.mjs configure omitted
  native_plugin_ui_opt_out capture
}

probe_native_plugin_ui_upgrade() {
  native_plugin_ui_upgrade_enabled || return 0
  local stage="$1" version="$baseline_version"
  [ "$stage" != candidate ] || version="$candidate_version"
  node scripts/e2e/lib/upgrade-survivor/native-plugin-ui.mjs probe "$stage" omitted "$version"
}

# Reuse the survivor's installed-driver, updater, readiness, and cleanup owners.
# The explicit-false specimen gets its own real published updater invocation;
# changing the flag only after upgrading would not prove preservation.
native_plugin_ui_opt_out() (
  trap - EXIT ERR HUP INT TERM
  local mode="$1" source_artifacts="$ARTIFACT_ROOT" source_prefix="$npm_config_prefix"
  local probe="$RUNTIME_ROOT/native-ui-opt-out"
  native_plugin_ui_upgrade_enabled || return 0
  if [ "$mode" = capture ]; then
    mkdir -p "$probe"
    cp -a "$source_prefix" "$probe/npm-prefix"
  fi
  ARTIFACT_ROOT="$source_artifacts/native-ui-opt-out"
  mkdir -p "$ARTIFACT_ROOT" "$probe/home" "$probe/state"
  export HOME="$probe/home" USERPROFILE="$probe/home" OPENCLAW_HOME="$probe/home"
  export OPENCLAW_STATE_DIR="$probe/state" OPENCLAW_CONFIG_PATH="$probe/state/openclaw.json"
  export OPENCLAW_TEST_WORKSPACE_DIR="$probe/state/workspace" OPENCLAW_GATEWAY_PORT=18789
  unset OPENCLAW_PROFILE OPENCLAW_AGENT_DIR PI_CODING_AGENT_DIR DISCORD_BOT_TOKEN TELEGRAM_BOT_TOKEN
  export npm_config_prefix="$probe/npm-prefix" NPM_CONFIG_PREFIX="$probe/npm-prefix"
  export PATH="$npm_config_prefix/bin:$PATH"
  export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
  BASELINE_PACKAGE_ROOT="$npm_config_prefix/lib/node_modules/openclaw"
  UPDATE_JSON="$ARTIFACT_ROOT/update.json"
  UPDATE_ERR="$ARTIFACT_ROOT/update.err"
  POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/post-update-validate.json"
  POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/post-update-validate.err"
  GATEWAY_LOG="$ARTIFACT_ROOT/baseline-gateway.log"
  SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_ROOT/systemctl-shim.pid"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
  gateway_pid=""
  update_repair_required=0
  initial_update_observation_root=""
  trap stop_gateway EXIT
  if [ "$mode" = capture ]; then
    cp "$source_artifacts/native-ui-fixture.tgz" "$ARTIFACT_ROOT/native-ui-fixture.tgz"
    [ "$(read_installed_version)" = "$baseline_version" ] || return 1
    openclaw_e2e_fixture_plugin_command openclaw -- plugins install openclaw-survivor-native-ui@1.0.0 --force
    node scripts/e2e/lib/upgrade-survivor/native-plugin-ui.mjs configure false
    start_gateway
    node scripts/e2e/lib/upgrade-survivor/native-plugin-ui.mjs probe baseline false "$baseline_version"
    stop_gateway
    return
  fi
  [ "$mode" = verify ] || { echo "Unknown native UI opt-out proof mode: $mode" >&2; return 1; }
  [ "$(read_installed_version)" = "$baseline_version" ] || return 1
  update_candidate
  [ "$update_outcome" = success ] && [ "$update_repair_required" = 0 ] || {
    echo "Native UI opt-out upgrade required additional repair" >&2
    return 1
  }
  GATEWAY_LOG="$ARTIFACT_ROOT/candidate-gateway.log"
  start_gateway
  node scripts/e2e/lib/upgrade-survivor/native-plugin-ui.mjs probe candidate false "$candidate_version" "$source_artifacts/native-ui-allowed-module.json"
  stop_gateway
)
