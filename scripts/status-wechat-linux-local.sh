#!/usr/bin/env bash

set -euo pipefail

PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
PID_FILE="${OPENCLAW_GATEWAY_PID_FILE:-$STATE_DIR/wechat-linux-gateway.pid}"
LOG_DIR="${OPENCLAW_LOG_DIR:-/tmp/openclaw}"
LOG_LINK="$LOG_DIR/wechat-linux-gateway.latest.log"

log() {
  printf '[wechat-linux-status] %s\n' "$*"
}

listener_lines="$(ss -ltnp 2>/dev/null | awk -v port=":${PORT}" '$4 ~ port { print }')"

if [[ -n "$listener_lines" ]]; then
  log "gateway is listening on port $PORT"
  printf '%s\n' "$listener_lines"
else
  log "gateway is not listening on port $PORT"
fi

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    log "pid file: $PID_FILE (running pid $pid)"
  else
    log "pid file exists but process is not running: $PID_FILE"
  fi
else
  log "pid file not found: $PID_FILE"
fi

if [[ -L "$LOG_LINK" || -f "$LOG_LINK" ]]; then
  resolved_log="$(readlink -f "$LOG_LINK" 2>/dev/null || printf '%s' "$LOG_LINK")"
  log "latest log: $resolved_log"
  tail -n 20 "$resolved_log" 2>/dev/null || true
else
  log "latest log not found: $LOG_LINK"
fi
