#!/usr/bin/env bash
set -euo pipefail
trap "" PIPE
export TERM=xterm-256color
export NO_COLOR=1

source scripts/lib/openclaw-e2e-instance.sh

source scripts/e2e/lib/release-scenarios/setup.sh
export OPENAI_API_KEY="sk-openclaw-release-user-journey"
export OPENCLAW_GATEWAY_TOKEN="release-user-journey-token"
export CLICKCLACK_BOT_TOKEN="clickclack-release-token"

PORT="18789"
MOCK_PORT="44180"
CLICKCLACK_PORT="44181"
SUCCESS_MARKER="OPENCLAW_E2E_OK_RELEASE_USER_JOURNEY"
scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-user-journey.XXXXXX")"
LOG_DIR="$scenario_tmp/logs"
mkdir -p "$LOG_DIR"
openclaw_release_scenario_logs \
  INSTALL_LOG "$LOG_DIR/install.log" \
  ONBOARD_LOG "$LOG_DIR/onboard.log" \
  OPENAI_LOG "$LOG_DIR/openai.log" \
  MOCK_REQUEST_LOG "$scenario_tmp/openai-requests.jsonl" \
  AGENT_LOG "$LOG_DIR/agent.log" \
  PLUGIN_A_INSTALL_LOG "$LOG_DIR/plugin-a-install.log" \
  PLUGIN_A_CLI_LOG "$LOG_DIR/plugin-a-cli.log" \
  PLUGIN_A_UNINSTALL_LOG "$LOG_DIR/plugin-a-uninstall.log" \
  PLUGIN_B_INSTALL_LOG "$LOG_DIR/plugin-b-install.log" \
  PLUGIN_B_CLI_LOG "$LOG_DIR/plugin-b-cli.log" \
  CLICKCLACK_PLUGIN_INSTALL_LOG "$LOG_DIR/clickclack-plugin-install.log" \
  CLICKCLACK_SERVER_LOG "$LOG_DIR/clickclack-server.log" \
  CLICKCLACK_OUTBOUND_JSON "$LOG_DIR/clickclack-outbound.json" \
  GATEWAY_1_LOG "$LOG_DIR/gateway-1.log" \
  GATEWAY_2_LOG "$LOG_DIR/gateway-2.log" \
  STATUS_JSON "$LOG_DIR/status.json" \
  STATUS_AFTER_RESTART_JSON "$LOG_DIR/status-after-restart.json" \
  DOCTOR_LOG "$LOG_DIR/doctor.log" \
  CLICKCLACK_STATE "$scenario_tmp/clickclack.json"
PLUGIN_B_AFTER_RESTART_JSON="$LOG_DIR/plugin-b-after-restart.json"
CLICKCLACK_OUTBOUND_ERR="$LOG_DIR/clickclack-outbound.err"
STATUS_ERR="$LOG_DIR/status.err"
STATUS_AFTER_RESTART_ERR="$LOG_DIR/status-after-restart.err"
PLUGIN_A_INSTALL_PATH_FILE="$scenario_tmp/plugin-a-install-path.txt"
PLUGIN_A_SOURCE_PATH_FILE="$scenario_tmp/plugin-a-source-path.txt"
export SUCCESS_MARKER MOCK_REQUEST_LOG CLICKCLACK_STATE

mock_pid=""
clickclack_pid=""
gateway_pid=""

cleanup() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  openclaw_e2e_stop_process "${clickclack_pid:-}"
  openclaw_e2e_stop_process "${mock_pid:-}"
  rm -rf "$scenario_tmp"
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "release user journey failed with exit code $status" >&2
  openclaw_e2e_dump_logs "${OPENCLAW_RELEASE_DIAGNOSTIC_LOGS[@]}"
}
openclaw_e2e_enable_failure_diagnostics

write_journey_plugin() {
  node --input-type=module - "$@" <<'NODE'
import { writeCliPlugin } from "./scripts/e2e/lib/fixtures/plugins.mjs";
writeCliPlugin(process.argv.slice(2), null);
NODE
}

openclaw_e2e_install_package "$INSTALL_LOG"
command -v openclaw >/dev/null
package_root="$(openclaw_e2e_package_root)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
openclaw_e2e_enable_openclaw_cli_timeout

mock_pid="$(openclaw_e2e_start_mock_openai "$MOCK_PORT" "$OPENAI_LOG")"
openclaw_e2e_wait_mock_openai "$MOCK_PORT"

start_clickclack_fixture "$CLICKCLACK_BOT_TOKEN"

echo "Running non-interactive onboarding..."
openclaw_release_onboard "$PORT" openclaw >"$ONBOARD_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-onboard "$HOME"
node scripts/e2e/lib/release-user-journey/assertions.mjs configure-mock-model "$MOCK_PORT"

echo "Running package-installed agent turn..."
openclaw agent --local \
  --agent main \
  --session-id release-user-journey-agent \
  --message "Return marker $SUCCESS_MARKER" \
  --thinking off \
  --json >"$AGENT_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-agent-turn "$SUCCESS_MARKER" "$AGENT_LOG" "$MOCK_REQUEST_LOG"

echo "Installing first external plugin..."
plugin_a_dir="$(mktemp -d "$scenario_tmp/plugin-a.XXXXXX")"
plugin_a_install_path_file="$PLUGIN_A_INSTALL_PATH_FILE"
plugin_a_source_path_file="$PLUGIN_A_SOURCE_PATH_FILE"
write_journey_plugin "$plugin_a_dir" journey-plugin-a 0.0.1 journey.a "Journey Plugin A" journey-a "journey-plugin-a:pong"
openclaw_e2e_fixture_plugin_command openclaw -- plugins install "$plugin_a_dir" --force >"$PLUGIN_A_INSTALL_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs \
  remember-plugin-install-path \
  journey-plugin-a \
  "$plugin_a_install_path_file" \
  "$plugin_a_source_path_file" \
  "$plugin_a_dir"
openclaw journey-a ping >"$PLUGIN_A_CLI_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-file-contains "$PLUGIN_A_CLI_LOG" "journey-plugin-a:pong"

echo "Uninstalling first external plugin..."
openclaw plugins uninstall journey-plugin-a --force >"$PLUGIN_A_UNINSTALL_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs \
  assert-plugin-uninstalled \
  journey-plugin-a \
  "$plugin_a_install_path_file" \
  "$plugin_a_source_path_file"

echo "Installing replacement external plugin..."
plugin_b_dir="$(mktemp -d "$scenario_tmp/plugin-b.XXXXXX")"
write_journey_plugin "$plugin_b_dir" journey-plugin-b 0.0.1 journey.b "Journey Plugin B" journey-b "journey-plugin-b:pong"
openclaw_e2e_fixture_plugin_command openclaw -- plugins install "$plugin_b_dir" --force >"$PLUGIN_B_INSTALL_LOG" 2>&1
openclaw journey-b ping >"$PLUGIN_B_CLI_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-file-contains "$PLUGIN_B_CLI_LOG" "journey-plugin-b:pong"

echo "Installing ClickClack fixture plugin..."
clickclack_plugin_dir="$(mktemp -d "$scenario_tmp/clickclack-plugin.XXXXXX")"
node scripts/e2e/lib/release-user-journey/write-clickclack-plugin.mjs "$clickclack_plugin_dir"
openclaw_e2e_fixture_plugin_command openclaw -- plugins install "$clickclack_plugin_dir" --force >"$CLICKCLACK_PLUGIN_INSTALL_LOG" 2>&1

echo "Configuring ClickClack..."
node scripts/e2e/lib/release-user-journey/assertions.mjs configure-clickclack "http://127.0.0.1:$CLICKCLACK_PORT"
openclaw channels status --json >"$STATUS_JSON" 2>"$STATUS_ERR"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-channel-configured clickclack "$STATUS_JSON"

echo "Sending ClickClack outbound message..."
openclaw message send \
  --channel clickclack \
  --target channel:general \
  --message "release journey outbound" \
  --json >"$CLICKCLACK_OUTBOUND_JSON" 2>"$CLICKCLACK_OUTBOUND_ERR"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-clickclack-state outbound "$CLICKCLACK_STATE" "release journey outbound"

echo "Starting Gateway for ClickClack inbound..."
start_gateway "$GATEWAY_1_LOG"
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-socket "http://127.0.0.1:$CLICKCLACK_PORT" 45
node scripts/e2e/lib/release-user-journey/assertions.mjs post-clickclack-inbound "http://127.0.0.1:$CLICKCLACK_PORT" "Return marker $SUCCESS_MARKER"
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-reply "$CLICKCLACK_STATE" "$SUCCESS_MARKER" 45

echo "Restarting Gateway and checking state survival..."
stop_gateway
start_gateway "$GATEWAY_2_LOG"
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-socket "http://127.0.0.1:$CLICKCLACK_PORT" 45 2
openclaw plugins inspect journey-plugin-b --runtime --json >"$PLUGIN_B_AFTER_RESTART_JSON" 2>&1
openclaw channels status --json >"$STATUS_AFTER_RESTART_JSON" 2>"$STATUS_AFTER_RESTART_ERR"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-channel-running clickclack "$STATUS_AFTER_RESTART_JSON"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-file-contains "$PLUGIN_B_AFTER_RESTART_JSON" "journey-plugin-b"
stop_gateway

echo "Running doctor at end of release journey..."
openclaw doctor --repair --non-interactive >"$DOCTOR_LOG" 2>&1

echo "Release user journey scenario passed."
