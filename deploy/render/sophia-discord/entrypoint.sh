#!/usr/bin/env bash
# Sophia Render entrypoint — runs bootstrap then starts the gateway.
#
# Set as the Docker command override in Render dashboard:
#   bash /app/deploy/render/sophia-discord/entrypoint.sh
#
# This ensures the config file exists before the gateway starts,
# avoiding the "Missing config" crash when OPENCLAW_CONFIG_PATH is set.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Run bootstrap (idempotent — only copies config if missing)
bash "$SCRIPT_DIR/bootstrap.sh"

# Start the gateway
exec node /app/openclaw.mjs gateway --allow-unconfigured
