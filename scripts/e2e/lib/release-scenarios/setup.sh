#!/usr/bin/env bash

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
openclaw_e2e_install_trash_shim

export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false

# The same ordered inventory defines artifact paths and failure diagnostics.
openclaw_release_scenario_logs() {
  OPENCLAW_RELEASE_DIAGNOSTIC_LOGS=()
  while [ "$#" -gt 0 ]; do
    printf -v "$1" '%s' "$2"
    OPENCLAW_RELEASE_DIAGNOSTIC_LOGS+=("$2")
    shift 2
  done
}

openclaw_release_onboard() {
  local port="$1"
  shift
  set -- "$@" onboard \
    --non-interactive \
    --accept-risk \
    --flow quickstart \
    --mode local \
    --auth-choice skip
  if [ -n "$port" ]; then
    set -- "$@" --gateway-port "$port" --gateway-bind loopback
  fi
  "$@" \
    --skip-daemon \
    --skip-ui \
    --skip-channels \
    --skip-skills \
    --skip-health
}

start_gateway() {
  local log_path="$1"
  gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$log_path")"
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$log_path" 300 "$PORT"
}

stop_gateway() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  gateway_pid=""
}

start_clickclack_fixture() {
  local token="$1"
  CLICKCLACK_FIXTURE_PORT="$CLICKCLACK_PORT" \
  CLICKCLACK_FIXTURE_TOKEN="$token" \
  CLICKCLACK_FIXTURE_STATE="$CLICKCLACK_STATE" \
    node scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs >"$CLICKCLACK_SERVER_LOG" 2>&1 &
  clickclack_pid="$!"
  for _ in $(seq 1 100); do
    if openclaw_e2e_probe_http_status "http://127.0.0.1:$CLICKCLACK_PORT/health" 200 >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  openclaw_e2e_probe_http_status "http://127.0.0.1:$CLICKCLACK_PORT/health" 200
}
