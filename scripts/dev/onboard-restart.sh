#!/usr/bin/env bash
set -euo pipefail

if command -v git >/dev/null 2>&1; then
  ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [[ -z "${ROOT_DIR:-}" ]]; then
  SCRIPT_PATH="${BASH_SOURCE[0]-}"
  if [[ -z "${SCRIPT_PATH}" ]]; then
    SCRIPT_PATH="${0}"
  fi
  if [[ -f "$SCRIPT_PATH" ]]; then
    ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
  else
    ROOT_DIR="$(pwd)"
  fi
fi

if [[ -n "${OPENCLAW_CMD:-}" ]]; then
  : # explicit override from env
elif command -v pnpm >/dev/null 2>&1; then
  OPENCLAW_CMD="pnpm openclaw"
elif command -v bun >/dev/null 2>&1; then
  OPENCLAW_CMD="bun run openclaw"
else
  OPENCLAW_CMD="node scripts/run-node.mjs"
fi

read -r -a OPENCLAW_CMD_ARR <<< "$OPENCLAW_CMD"
read -r -a ONBOARD_ARGS <<< "onboard --reset --accept-risk --flow quickstart --mode local --skip-channels --skip-skills --skip-daemon --skip-ui --skip-health --auth-choice skip"
read -r -a GATEWAY_ARGS <<< "gateway run --dev --force --allow-unconfigured"

: "${OPENCLAW_PROFILE:=dev}"
GATEWAY_LOG_FILE="${OPENCLAW_GATEWAY_LOG_FILE:-/tmp/openclaw-dev-gateway.log}"
GATEWAY_PID_FILE="${OPENCLAW_GATEWAY_PID_FILE:-/tmp/openclaw-dev-gateway.pid}"
START_GATEWAY=1
FOREGROUND_GATEWAY=0
SKIP_RESET=0

usage() {
  cat <<'USAGE'
Usage: scripts/dev/onboard-restart.sh [options]

Options:
  --no-gateway        Skip gateway restart after onboarding.
  --foreground        Run gateway in foreground (script blocks).
  --no-reset          Skip --reset during onboarding.
  --help              Show this help.

Environment:
  OPENCLAW_CMD             Command to execute (defaults to local `pnpm openclaw`).
  OPENCLAW_PROFILE          Dev profile to use (defaults to `dev`).
  OPENCLAW_GATEWAY_LOG_FILE  Gateway log path (default: /tmp/openclaw-dev-gateway.log).
  OPENCLAW_GATEWAY_PID_FILE  PID file for background gateway process (default: /tmp/openclaw-dev-gateway.pid).

Examples:
  pnpm dev:onboard:retry
  OPENCLAW_PROFILE=dev pnpm dev:onboard:retry --no-reset
  OPENCLAW_PROFILE=dev pnpm dev:onboard:retry --foreground
  OPENCLAW_PROFILE=dev pnpm dev:onboard:retry --no-gateway
USAGE
}

run_openclaw() {
  (cd "$ROOT_DIR" && "${OPENCLAW_CMD_ARR[@]}" "$@")
}

run_openclaw_bg() {
  mkdir -p "$(dirname "$GATEWAY_LOG_FILE")"
  (cd "$ROOT_DIR" && "${OPENCLAW_CMD_ARR[@]}" "$@" >"$GATEWAY_LOG_FILE" 2>&1) &
  local gateway_pid=$!
  echo "$gateway_pid" > "$GATEWAY_PID_FILE"
  echo "Gateway started in background (pid=$gateway_pid), log: $GATEWAY_LOG_FILE"
}

kill_existing_gateway() {
  if [[ -f "$GATEWAY_PID_FILE" ]]; then
    old_pid="$(tr -dc '0-9' < "$GATEWAY_PID_FILE" | tr -d '\n')"
    if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      wait "$old_pid" 2>/dev/null || true
    fi
    rm -f "$GATEWAY_PID_FILE"
  fi

  if command -v pkill >/dev/null; then
    pkill -f "openclaw.*gateway.*run.*--dev" 2>/dev/null || true
    pkill -f "openclaw\\.mjs.*gateway.*run.*--dev" 2>/dev/null || true
  fi
}

while (($#)); do
  case "${1:-}" in
    --no-gateway)
      START_GATEWAY=0
      shift
      ;;
    --foreground)
      FOREGROUND_GATEWAY=1
      shift
      ;;
    --no-reset)
      SKIP_RESET=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: ${1:-}" >&2
      usage
      exit 1
      ;;
  esac
done

if (( SKIP_RESET == 1 )); then
  for i in "${!ONBOARD_ARGS[@]}"; do
    if [[ "${ONBOARD_ARGS[$i]}" == "--reset" ]]; then
      ONBOARD_ARGS=("${ONBOARD_ARGS[@]:0:$i}" "${ONBOARD_ARGS[@]:$((i+1))}")
      break
    fi
  done
fi

kill_existing_gateway
export OPENCLAW_PROFILE

echo "Running onboarding..."
run_openclaw "${ONBOARD_ARGS[@]}"

if (( START_GATEWAY == 0 )); then
  echo "Gateway restart skipped. To start gateway manually:"
  echo "  run: pnpm openclaw ${GATEWAY_ARGS[*]}"
  exit 0
fi

echo "Starting gateway..."
if (( FOREGROUND_GATEWAY == 1 )); then
  run_openclaw "${GATEWAY_ARGS[@]}"
else
  run_openclaw_bg "${GATEWAY_ARGS[@]}"
  echo "Log tail:"
  echo "  tail -f $GATEWAY_LOG_FILE"
fi
