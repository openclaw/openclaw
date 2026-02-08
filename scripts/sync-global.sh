#!/bin/bash
# sync-global.sh — Sync global openclaw binary after local build.
# Prevents version mismatch between config and running gateway.
#
# Usage:
#   scripts/sync-global.sh          # compare + install if needed
#   scripts/sync-global.sh --check  # compare only, exit 1 if mismatch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

BUILT=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)" 2>/dev/null)
CURRENT=$(openclaw --version 2>/dev/null || echo "not-installed")

if [ "$CURRENT" = "$BUILT" ]; then
  echo "[sync-global] OK: global=$CURRENT, built=$BUILT"
  exit 0
fi

echo "[sync-global] Mismatch: global=$CURRENT, built=$BUILT"

if [ "${1:-}" = "--check" ]; then
  exit 1
fi

echo "[sync-global] Installing globally..."
cd "$PROJECT_DIR"
sudo npm i -g . 2>/dev/null || {
  echo "[sync-global] WARN: global sync failed (no sudo or npm error). Run manually:"
  echo "  sudo npm i -g $PROJECT_DIR"
  exit 1
}

AFTER=$(openclaw --version 2>/dev/null || echo "failed")
echo "[sync-global] Done: $CURRENT → $AFTER"
