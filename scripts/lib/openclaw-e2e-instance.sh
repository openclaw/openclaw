#!/usr/bin/env bash
# Shared in-container lifecycle helpers for Docker/Bash E2E lanes.
openclaw_e2e_eval_test_state_from_b64() { eval "$(printf '%s' "${1:?missing OpenClaw test-state script}" | base64 -d)"; }
openclaw_e2e_resolve_entrypoint() {
  local entry
  for entry in dist/index.mjs dist/index.js; do
    [ -f "$entry" ] && { printf '%s\n' "$entry"; return 0; }
  done
  echo "OpenClaw entrypoint not found under dist/" >&2
  return 1
}
openclaw_e2e_write_state_env() {
  local target="${1:-/tmp/openclaw-test-state-env}"
  {
    printf 'export HOME=%q\n' "$HOME"
    printf 'export OPENCLAW_HOME=%q\n' "$OPENCLAW_HOME"
    printf 'export OPENCLAW_STATE_DIR=%q\n' "$OPENCLAW_STATE_DIR"
    printf 'export OPENCLAW_CONFIG_PATH=%q\n' "$OPENCLAW_CONFIG_PATH"
    printf 'export OPENCLAW_AGENT_DIR=%q\n' "${OPENCLAW_AGENT_DIR-}"
    printf 'export PI_CODING_AGENT_DIR=%q\n' "${PI_CODING_AGENT_DIR-}"
  } >"$target"
}
openclaw_e2e_stop_process() {
  local pid="${1:-}" _
  [ -n "$pid" ] || return 0
  kill "$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    ! kill -0 "$pid" >/dev/null 2>&1 && { wait "$pid" >/dev/null 2>&1 || true; return 0; }
    sleep 0.25
  done
  kill -9 "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}
openclaw_e2e_start_mock_openai() { MOCK_PORT="$1" node scripts/e2e/mock-openai-server.mjs >"$2" 2>&1 & printf '%s\n' "$!"; }
openclaw_e2e_wait_mock_openai() {
  local port="$1" attempts="${2:-80}" _
  local probe="fetch('http://127.0.0.1:' + process.argv[1] + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  for _ in $(seq 1 "$attempts"); do
    node -e "$probe" "$port" && return 0
    sleep 0.1
  done
  node -e "$probe" "$port"
}
openclaw_e2e_start_gateway() { node "$1" gateway --port "$2" --bind loopback --allow-unconfigured >"$3" 2>&1 & printf '%s\n' "$!"; }
openclaw_e2e_exec_gateway() { exec node "$1" gateway --port "$2" --bind "${3:-loopback}" --allow-unconfigured >"$4" 2>&1; }
openclaw_e2e_wait_gateway_ready() {
  local pid="$1" log="$2" attempts="${3:-300}" _
  for _ in $(seq 1 "$attempts"); do
    ! kill -0 "$pid" >/dev/null 2>&1 && {
      echo "Gateway exited before becoming ready"
      wait "$pid" || true
      tail -n 120 "$log" 2>/dev/null || true
      return 1
    }
    grep -q '\[gateway\] ready' "$log" 2>/dev/null && return 0
    sleep 0.25
  done
  echo "Gateway did not become ready"
  tail -n 120 "$log" 2>/dev/null || true
  return 1
}
openclaw_e2e_probe_tcp() {
  node --input-type=module -e '
    import net from "node:net";
    const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
    const timeout = setTimeout(() => { socket.destroy(); process.exit(1); }, Number(process.argv[3] ?? 400));
    socket.on("connect", () => { clearTimeout(timeout); socket.end(); process.exit(0); });
    socket.on("error", () => { clearTimeout(timeout); process.exit(1); });
  ' "$1" "$2" "${3:-400}"
}
openclaw_e2e_probe_http_status() {
  node -e 'fetch(process.argv[1]).then(r=>process.exit(r.status===Number(process.argv[2])?0:1)).catch(()=>process.exit(1))' "$1" "${2:-200}"
}
openclaw_e2e_dump_logs() {
  local path
  for path in "$@"; do
    [ -f "$path" ] || continue
    echo "--- $path ---"; tail -n "${OPENCLAW_E2E_LOG_TAIL_LINES:-120}" "$path" || true
  done
}
