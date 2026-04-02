#!/usr/bin/env sh

# Safe gateway restart script
# This script restarts the gateway process safely without killing the script itself
# It reads config from ~/.openclaw/openclaw.json or uses env var defaults

set -eu

# Configuration file path
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

# Get port and bind from config file or environment variables
if [ -f "$OPENCLAW_CONFIG" ]; then
  GATEWAY_PORT="$(node -e "console.log(require('$OPENCLAW_CONFIG').gateway?.port || '18789')" 2>/dev/null)"
  GATEWAY_BIND="$(node -e "console.log(require('$OPENCLAW_CONFIG').gateway?.bind || 'loopback')" 2>/dev/null)"
else
  GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
  GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"
fi

# Log file path (default to ~/.openclaw/logs/gateway-restart.log)
LOG_PATH="${OPENCLAW_GATEWAY_RESTART_LOG:-$HOME/.openclaw/logs/gateway-restart.log}"

# Ensure log directory exists
LOG_DIR="$(dirname "${LOG_PATH}")"
mkdir -p "${LOG_DIR}" 2>/dev/null || true

# Log restart request with POSIX-compatible timestamp
# Use date -u + for cross-platform compatibility (works on both GNU and BSD date)
printf "%s\n" "==> openclaw gateway restart requested at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# Kill only the gateway process, NOT the script itself
# Use -x to match exact command name and avoid matching the script's own command line
pkill -9 -f -x "openclaw-gateway" || true

sleep 2

# Start gateway in background with proper env var forwarding
# Forward all necessary env vars to the detached shell
nohup env \
  LOG_PATH="${LOG_PATH}" \
  GATEWAY_PORT="${GATEWAY_PORT}" \
  GATEWAY_BIND="${GATEWAY_BIND}" \
sh -c '
  {
    # Log restart completion with POSIX-compatible timestamp
    printf "%s\n" "==> openclaw gateway restarted at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    # Start gateway with config-provided or defaulted port/bind
    openclaw gateway run --bind "${GATEWAY_BIND}" --port "${GATEWAY_PORT}" --force
  } >> "${LOG_PATH}" 2>&1
' >/dev/null 2>&1 &

printf "%s\n" "Gateway restart scheduled; see ${LOG_PATH} for details."
