#!/usr/bin/env bash
# Start ClaWorks gateway in dev mode (isolated from OpenClaw on 18789).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CLAWORKS_PRODUCT=1
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.claworks}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/claworks.json}"
PORT="${CLAWORKS_GATEWAY_PORT:-18800}"

if [[ ! -f "$OPENCLAW_CONFIG_PATH" ]]; then
  echo "Config missing — run: pnpm claworks:init"
  exit 1
fi

cd "$ROOT"
exec node --import tsx src/entry.ts gateway run --port "$PORT" --bind loopback "$@"
