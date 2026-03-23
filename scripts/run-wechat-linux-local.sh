#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$STATE_DIR/openclaw.json}"
ENV_FILE="${OPENCLAW_ENV_FILE:-$STATE_DIR/.env}"
PID_FILE="${OPENCLAW_GATEWAY_PID_FILE:-$STATE_DIR/wechat-linux-gateway.pid}"
LOG_DIR="${OPENCLAW_LOG_DIR:-/tmp/openclaw}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
BIND_MODE="${OPENCLAW_GATEWAY_BIND:-loopback}"
FOREGROUND=1
FORCE_FLAG="--force"
VERBOSE_FLAG=""
TAIL_LINES="${TAIL_LINES:-80}"

usage() {
  cat <<'USAGE'
Usage: scripts/run-wechat-linux-local.sh [options]

Options:
  --background         Start in background and write logs to a file
  --foreground         Start in foreground and mirror logs to terminal
  --env-file <path>    Load environment variables from this file before start
  --log-file <path>    Override log file path
  --port <port>        Override gateway port (default: 18789)
  --bind <mode>        Override bind mode (default: loopback)
  --no-force           Do not pass --force to the gateway
  --verbose            Pass --verbose to the gateway
  --help               Show this help

Environment defaults:
  OPENCLAW_STATE_DIR   Default: $HOME/.openclaw
  OPENCLAW_ENV_FILE    Default: $HOME/.openclaw/.env
  OPENCLAW_GATEWAY_PID_FILE
  OPENCLAW_LOG_DIR     Default: /tmp/openclaw
  OPENCLAW_GATEWAY_PORT
  OPENCLAW_GATEWAY_BIND
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[wechat-linux-run] %s\n' "$*"
}

resolve_default_log_path() {
  local timestamp
  timestamp="$(date '+%Y-%m-%d-%H%M%S')"
  printf '%s/wechat-linux-gateway-%s.log' "$LOG_DIR" "$timestamp"
}

LOG_PATH="$(resolve_default_log_path)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --background)
      FOREGROUND=0
      shift
      ;;
    --foreground)
      FOREGROUND=1
      shift
      ;;
    --env-file)
      [[ $# -ge 2 ]] || fail "--env-file requires a path"
      ENV_FILE="$2"
      shift 2
      ;;
    --log-file)
      [[ $# -ge 2 ]] || fail "--log-file requires a path"
      LOG_PATH="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || fail "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --bind)
      [[ $# -ge 2 ]] || fail "--bind requires a value"
      BIND_MODE="$2"
      shift 2
      ;;
    --no-force)
      FORCE_FLAG=""
      shift
      ;;
    --verbose)
      VERBOSE_FLAG="--verbose"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

mkdir -p "$LOG_DIR"
mkdir -p "$STATE_DIR"

if [[ ! -f "$CONFIG_PATH" ]]; then
  fail "config not found: $CONFIG_PATH"
fi

if [[ -f "$ENV_FILE" ]]; then
  log "loading env file: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  log "env file not found, continuing without it: $ENV_FILE"
fi

command -v pnpm >/dev/null 2>&1 || fail "pnpm not found in PATH; run corepack enable first"

LATEST_LINK="$LOG_DIR/wechat-linux-gateway.latest.log"
ln -sfn "$(basename "$LOG_PATH")" "$LATEST_LINK"

CMD=(pnpm openclaw gateway run --bind "$BIND_MODE" --port "$PORT")
if [[ -n "$FORCE_FLAG" ]]; then
  CMD+=("$FORCE_FLAG")
fi
if [[ -n "$VERBOSE_FLAG" ]]; then
  CMD+=("$VERBOSE_FLAG")
fi

log "repo: $ROOT_DIR"
log "config: $CONFIG_PATH"
log "pid file: $PID_FILE"
log "log: $LOG_PATH"
log "latest log link: $LATEST_LINK"
log "command: ${CMD[*]}"

cd "$ROOT_DIR"

if [[ "$FOREGROUND" -eq 1 ]]; then
  log "starting in foreground"
  printf '===== %s wechat-linux gateway start =====\n' "$(date '+%F %T')" | tee -a "$LOG_PATH"
  stdbuf -oL -eL "${CMD[@]}" 2>&1 | tee -a "$LOG_PATH"
else
  log "starting in background"
  printf '===== %s wechat-linux gateway start =====\n' "$(date '+%F %T')" >> "$LOG_PATH"
  nohup "${CMD[@]}" >> "$LOG_PATH" 2>&1 </dev/null &
  PID=$!
  printf '%s\n' "$PID" > "$PID_FILE"
  log "started pid: $PID"
  log "tail logs: tail -n ${TAIL_LINES} -f \"$LOG_PATH\""
fi
