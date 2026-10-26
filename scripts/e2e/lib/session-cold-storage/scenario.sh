#!/usr/bin/env bash
set -euo pipefail
case "${OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE:-required}" in
  required) ;;
  unsupported)
    echo "NOT RUN: cold transcript storage is unavailable in the selected frozen target"
    exit 0
    ;;
  *) echo "invalid frozen session cold-storage mode" >&2; exit 2 ;;
esac
source scripts/lib/openclaw-e2e-instance.sh

proof_dir="$(mktemp -d /tmp/openclaw-cold-storage-e2e.XXXXXX)"
export HOME="$proof_dir/home"
export OPENCLAW_STATE_DIR="$proof_dir/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_TEST_WORKSPACE_DIR="$proof_dir/workspace"
export OPENCLAW_GATEWAY_TOKEN="cold-storage-e2e-token"
export OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_CRON=1 OPENCLAW_SKIP_CANVAS_HOST=1
export OPENCLAW_SKIP_GMAIL_WATCHER=1 OPENCLAW_DISABLE_BONJOUR=1
export PORT=18789
mkdir -p "$HOME" "$OPENCLAW_STATE_DIR" "$OPENCLAW_TEST_WORKSPACE_DIR"
entry="$(openclaw_e2e_resolve_entrypoint)"
gateway_pid=""
gateway_log="$proof_dir/gateway.log"
cleanup() {
  openclaw_e2e_stop_process "$gateway_pid"
  rm -rf "$proof_dir"
}
trap cleanup EXIT
dump_debug_logs() {
  openclaw_e2e_dump_logs "$gateway_log"
}
openclaw_e2e_enable_failure_diagnostics

client() { node scripts/e2e/lib/session-cold-storage/client.mjs "$1" "$entry" "$proof_dir"; }
start_gateway() {
  gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$gateway_log")"
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$gateway_log" 300 "$PORT"
}
client seed
start_gateway
client exercise
kill -0 "$gateway_pid"
openclaw_e2e_stop_process "$gateway_pid"
start_gateway
client restart
openclaw_e2e_stop_process "$gateway_pid"
rm -rf "$OPENCLAW_STATE_DIR"
export OPENCLAW_STATE_DIR="$proof_dir/recovered"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
start_gateway
client recovered
echo "Cold transcript storage Docker E2E passed"
