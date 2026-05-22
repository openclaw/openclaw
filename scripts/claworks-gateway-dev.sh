#!/usr/bin/env bash
# ClaWorks dev gateway — OpenClaw-style: bootstrap + run (use `claworks start` when built).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CLAWORKS_PRODUCT=1
export _CLAWORKS_ARGV1=claworks
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.claworks}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/claworks.json}"
PORT="${CLAWORKS_GATEWAY_PORT:-18800}"

cd "$ROOT"

WATCH=0
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --watch|-w) WATCH=1 ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

ARGS=(start --port "$PORT" --bind loopback --force)
if [[ "$WATCH" -eq 1 ]]; then
  ARGS+=(--watch)
fi
ARGS+=("${PASSTHROUGH[@]}")

exec node --import tsx src/entry.ts "${ARGS[@]}"
