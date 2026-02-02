#!/usr/bin/env bash
set -euo pipefail

# Force OpenClaw to use /data as HOME
export HOME=/data

: "${OPENCLAW_STATE_DIR:=/data/.openclaw}"

# Railway requires binding to all interfaces (0.0.0.0)
# Default to 'lan' bind mode unless explicitly set
: "${OPENCLAW_GATEWAY_BIND:=lan}"

# Use PORT env var from Railway if set, otherwise default to 8080
: "${OPENCLAW_GATEWAY_PORT:=${PORT:-8080}}"

export OPENCLAW_GATEWAY_BIND
export OPENCLAW_GATEWAY_PORT
export OPENCLAW_STATE_DIR

if [[ -n "${OPENCLAW_CONFIG_PATH:-}" ]]; then
  export OPENCLAW_CONFIG_PATH
fi

# Create directories
mkdir -p "${OPENCLAW_STATE_DIR}" /data/workspace 2>/dev/null || true

# Run the entrypoint command
exec "$@"
