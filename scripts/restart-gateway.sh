#!/usr/bin/env bash

set -euo pipefail

LOG_PATH="${OPENCLAW_GATEWAY_RESTART_LOG:-/tmp/openclaw-gateway-restart.log}"

mkdir -p "$(dirname "${LOG_PATH}")"

nohup sh -c '
  LOG_PATH="'"${LOG_PATH}"'"
  {
    printf "%s\n" "==> openclaw gateway restart requested at $(date -Is)"
    pkill -f openclaw-gateway || true
    sleep 2
    openclaw gateway run --bind loopback --port 18789 --force
  } >>"${LOG_PATH}" 2>&1
' >/dev/null 2>&1 &

printf "%s\n" "Gateway restart scheduled; see ${LOG_PATH} for details."

