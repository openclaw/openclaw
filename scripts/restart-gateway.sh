#!/usr/bin/env bash

set -euo pipefail

LOG_PATH="${OPENCLAW_GATEWAY_RESTART_LOG:-/tmp/openclaw-gateway-restart.log}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"

mkdir -p "$(dirname "${LOG_PATH}")"

nohup env LOG_PATH="${LOG_PATH}" sh -c '
  {
    printf "%s\n" "==> openclaw gateway restart requested at $(date -u +\"%Y-%m-%dT%H:%M:%SZ\")"
    pkill -f openclaw-gateway || true
    sleep 2
    openclaw gateway run --bind "${GATEWAY_BIND}" --port "${GATEWAY_PORT}" --force
  } >>"${LOG_PATH}" 2>&1
' >/dev/null 2>&1 &

printf "%s\n" "Gateway restart scheduled; see ${LOG_PATH} for details."

