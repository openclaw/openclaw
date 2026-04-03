#!/usr/bin/env bash
# Sophia Discord + WhatsApp — Render first-boot config seeder
#
# Idempotent: copies the config template to the persistent disk only when
# no config file exists. Does NOT touch workspace, credentials, memory DB,
# or any other existing state.
#
# Usage: run once via Render Shell, or add to a Docker entrypoint wrapper.
#   bash /app/deploy/render/sophia-discord/bootstrap.sh

set -euo pipefail

CONFIG_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-$CONFIG_DIR/openclaw.json}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/openclaw.render.json5"

# Ensure state directory exists
mkdir -p "$CONFIG_DIR"

# Deploy config only when missing
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[bootstrap] No config found at $CONFIG_FILE — deploying template"

  if [ ! -f "$TEMPLATE" ]; then
    echo "[bootstrap] ERROR: template not found at $TEMPLATE" >&2
    exit 1
  fi

  # Strip JSON5 comments for runtime compatibility (openclaw reads JSON5 natively,
  # but stripping comments keeps the file parseable by plain JSON tools too)
  cp "$TEMPLATE" "$CONFIG_FILE"
  echo "[bootstrap] Config deployed to $CONFIG_FILE"
else
  echo "[bootstrap] Config already exists at $CONFIG_FILE — skipping"
fi

echo "[bootstrap] Done. Existing workspace, credentials, and memory are untouched."
