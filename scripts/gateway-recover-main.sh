#!/usr/bin/env bash

set -euo pipefail

MAIN_REPO="${OPENCLAW_MAIN_REPO:-/Users/user/Programming_Projects/openclaw}"
EXPECTED_RUNTIME="${MAIN_REPO}/dist/index.js"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
LISTENER_TIMEOUT_SECONDS="${OPENCLAW_GATEWAY_LISTENER_TIMEOUT_SECONDS:-300}"
RPC_TIMEOUT_SECONDS="${OPENCLAW_GATEWAY_RPC_TIMEOUT_SECONDS:-120}"
RETRY_KICKSTART_AFTER_SECONDS="${OPENCLAW_GATEWAY_RETRY_KICKSTART_AFTER_SECONDS:-30}"
POLL_INTERVAL_SECONDS="${OPENCLAW_GATEWAY_POLL_INTERVAL_SECONDS:-2}"
GATEWAY_LABEL="ai.openclaw.gateway"
WATCHDOG_LABEL="ai.openclaw.gateway-watchdog"
GATEWAY_ERR_LOG="${HOME}/.openclaw/logs/gateway.err.log"
WATCHDOG_ERR_LOG="/tmp/openclaw/gateway-watchdog.err.log"

log() {
  printf '[gateway-recover-main] %s\n' "$*"
}

log_block() {
  local title="$1"
  printf '\n[gateway-recover-main] %s\n' "$title"
}

dump_failure_diagnostics() {
  local failed_command="$1"
  local failed_output="$2"
  log_block "FAILURE DIAGNOSTICS"
  printf 'Failed command: %s\n' "$failed_command" >&2
  if [[ -n "$failed_output" ]]; then
    printf '%s\n' "$failed_output" >&2
  fi

  log_block "Tail ${GATEWAY_ERR_LOG} (last 120 lines)"
  if [[ -f "${GATEWAY_ERR_LOG}" ]]; then
    tail -n 120 "${GATEWAY_ERR_LOG}" >&2 || true
  else
    printf 'missing: %s\n' "${GATEWAY_ERR_LOG}" >&2
  fi

  log_block "Tail ${WATCHDOG_ERR_LOG} (last 120 lines)"
  if [[ -f "${WATCHDOG_ERR_LOG}" ]]; then
    tail -n 120 "${WATCHDOG_ERR_LOG}" >&2 || true
  else
    printf 'missing: %s\n' "${WATCHDOG_ERR_LOG}" >&2
  fi
}

run_strict() {
  local output
  if ! output="$("$@" 2>&1)"; then
    dump_failure_diagnostics "$*" "$output"
    exit 1
  fi
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
}

capture_best_effort() {
  local title="$1"
  shift
  log_block "$title"
  local output
  if output="$("$@" 2>&1)"; then
    printf '%s\n' "$output"
  else
    printf '%s\n' "$output"
    printf '[gateway-recover-main] (best-effort capture; non-zero exit ignored)\n'
  fi
}

listener_ready() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { found = 1 } END { exit(found ? 0 : 1) }'
}

assert_main_runtime_path() {
  local output
  if ! output="$(launchctl print "gui/$(id -u)/${GATEWAY_LABEL}" 2>&1)"; then
    dump_failure_diagnostics "launchctl print gui/\$(id -u)/${GATEWAY_LABEL}" "$output"
    exit 1
  fi
  if ! printf '%s\n' "$output" | rg -F -q "${EXPECTED_RUNTIME}"; then
    dump_failure_diagnostics "assert launchctl command path contains ${EXPECTED_RUNTIME}" "$output"
    exit 1
  fi
}

wait_for_listener() {
  local start_epoch
  start_epoch="$(date +%s)"
  local retried=0

  while true; do
    if listener_ready; then
      return 0
    fi

    local now elapsed
    now="$(date +%s)"
    elapsed="$((now - start_epoch))"

    if [[ "${retried}" -eq 0 && "${elapsed}" -ge "${RETRY_KICKSTART_AFTER_SECONDS}" ]]; then
      log "listener not ready after ${elapsed}s; issuing one controlled gateway kickstart"
      run_strict launchctl kickstart -k "gui/$(id -u)/${GATEWAY_LABEL}"
      retried=1
    fi

    if [[ "${elapsed}" -ge "${LISTENER_TIMEOUT_SECONDS}" ]]; then
      local lsof_output
      lsof_output="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>&1 || true)"
      dump_failure_diagnostics "wait for listener on ${PORT}" "$lsof_output"
      exit 1
    fi

    sleep "${POLL_INTERVAL_SECONDS}"
  done
}

wait_for_rpc_probe() {
  local start_epoch
  start_epoch="$(date +%s)"
  local last_output=""

  while true; do
    local output=""
    if output="$(openclaw gateway status --deep --require-rpc 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi

    last_output="$output"
    local now elapsed
    now="$(date +%s)"
    elapsed="$((now - start_epoch))"
    if [[ "${elapsed}" -ge "${RPC_TIMEOUT_SECONDS}" ]]; then
      dump_failure_diagnostics "openclaw gateway status --deep --require-rpc" "$last_output"
      exit 1
    fi
    sleep "${POLL_INTERVAL_SECONDS}"
  done
}

main() {
  log "starting deterministic recovery (port=${PORT}, main=${MAIN_REPO})"

  capture_best_effort "Baseline: status --deep --require-rpc" openclaw gateway status --deep --require-rpc
  capture_best_effort "Baseline: lsof listener check" lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN
  capture_best_effort \
    "Baseline: launchctl print (program/arguments/pid/state)" \
    bash -lc "launchctl print gui/\$(id -u)/${GATEWAY_LABEL} | rg 'program =|arguments =|pid =|state ='"

  log_block "Full clean stop"
  local uid
  uid="$(id -u)"
  launchctl bootout "gui/${uid}/${GATEWAY_LABEL}" 2>/dev/null || true
  launchctl bootout "gui/${uid}/${WATCHDOG_LABEL}" 2>/dev/null || true
  openclaw gateway stop 2>/dev/null || true
  pkill -9 -f openclaw-gateway 2>/dev/null || true
  pkill -9 -f 'dist/index.js gateway' 2>/dev/null || true
  pkill -9 -f 'openclaw.mjs gateway' 2>/dev/null || true
  run_strict bash -lc "ps aux | rg 'openclaw-gateway|dist/index.js gateway|openclaw.mjs gateway|ai.openclaw.gateway|gateway-health-watchdog' || true"
  run_strict bash -lc "lsof -nP -iTCP:${PORT} -sTCP:LISTEN || true"

  log_block "Rebuild and reinstall from main runtime"
  run_strict bash -lc "cd '${MAIN_REPO}' && pnpm build"
  run_strict bash -lc "cd '${MAIN_REPO}' && ./bin/openclaw gateway install --force --runtime node --port '${PORT}'"

  log_block "Bootstrap gateway launch agent"
  launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/${GATEWAY_LABEL}.plist" 2>/dev/null || true
  run_strict launchctl kickstart -k "gui/$(id -u)/${GATEWAY_LABEL}"

  log_block "Readiness gates"
  wait_for_listener
  wait_for_rpc_probe

  log_block "Bootstrap watchdog launch agent"
  launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/${WATCHDOG_LABEL}.plist" 2>/dev/null || true
  run_strict launchctl kickstart -k "gui/$(id -u)/${WATCHDOG_LABEL}"

  log_block "Final verification"
  assert_main_runtime_path
  local launch_command
  launch_command="$(launchctl print "gui/$(id -u)/${GATEWAY_LABEL}" | rg -F "${EXPECTED_RUNTIME}" || true)"
  local rpc_result
  rpc_result="$(openclaw gateway status --deep --require-rpc 2>&1)"
  local listener_result
  listener_result="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>&1)"

  printf 'LaunchAgent command path:\n%s\n' "${launch_command}"
  printf '\nRPC probe result:\n%s\n' "${rpc_result}"
  printf '\nListener result on %s:\n%s\n' "${PORT}" "${listener_result}"
}

main "$@"
