#!/usr/bin/env bash
set -euo pipefail

PID_FILE="${OPENCLAW_KEEPAWAKE_PID_FILE:-$HOME/.openclaw/run/keepawake.pid}"

usage() {
  cat <<'USAGE'
Usage: scripts/openclaw-keepawake.sh <on|off|status|restart>

Keeps macOS awake using `caffeinate` for long-running OpenClaw Docker sessions.

Commands:
  on       Start keep-awake background process
  off      Stop keep-awake background process
  status   Show current keep-awake status
  restart  Restart keep-awake background process
USAGE
}

ensure_caffeinate() {
  if ! command -v caffeinate >/dev/null 2>&1; then
    echo "caffeinate not found (this helper is for macOS)." >&2
    exit 1
  fi
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' <"$PID_FILE"
  fi
}

is_caffeinate_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  local comm
  comm="$(ps -p "$pid" -o comm= 2>/dev/null | tr -d '[:space:]')"
  [[ "$comm" == "caffeinate" ]]
}

start_awake() {
  ensure_caffeinate
  mkdir -p "$(dirname "$PID_FILE")"

  local pid
  pid="$(read_pid || true)"
  if is_caffeinate_pid "$pid"; then
    echo "keep-awake already on (pid $pid)"
    return 0
  fi

  caffeinate -dimsu >/dev/null 2>&1 &
  pid="$!"
  echo "$pid" >"$PID_FILE"
  echo "keep-awake on (pid $pid)"
}

stop_awake() {
  local pid
  pid="$(read_pid || true)"
  if [[ -z "$pid" ]]; then
    echo "keep-awake already off"
    return 0
  fi

  if is_caffeinate_pid "$pid"; then
    kill "$pid" >/dev/null 2>&1 || true
    echo "keep-awake off (stopped pid $pid)"
  else
    echo "keep-awake off (stale pid file removed)"
  fi
  rm -f "$PID_FILE"
}

status_awake() {
  local pid
  pid="$(read_pid || true)"
  if is_caffeinate_pid "$pid"; then
    echo "keep-awake is on (pid $pid)"
  else
    echo "keep-awake is off"
    if [[ -n "$pid" ]]; then
      rm -f "$PID_FILE"
    fi
  fi
}

cmd="${1:-}"
case "$cmd" in
on)
  start_awake
  ;;
off)
  stop_awake
  ;;
status)
  status_awake
  ;;
restart)
  stop_awake
  start_awake
  ;;
*)
  usage
  exit 2
  ;;
esac
