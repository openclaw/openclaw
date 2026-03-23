#!/usr/bin/env bash

set -euo pipefail

PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
PID_FILE="${OPENCLAW_GATEWAY_PID_FILE:-$STATE_DIR/wechat-linux-gateway.pid}"

log() {
  printf '[wechat-linux-stop] %s\n' "$*"
}

find_listener_pids() {
  ss -ltnp 2>/dev/null \
    | awk -v port=":${PORT}" '$4 ~ port { print }' \
    | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
    | sort -u
}

terminate_pid() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
}

stopped=0

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]]; then
    log "stopping pid from pid file: $pid"
    terminate_pid "$pid"
    stopped=1
  fi
  rm -f "$PID_FILE"
fi

while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  log "stopping listener pid on port $PORT: $pid"
  terminate_pid "$pid"
  stopped=1
done < <(find_listener_pids)

if [[ "$stopped" -eq 1 ]]; then
  log "gateway stopped"
else
  log "no gateway listener found on port $PORT"
fi
