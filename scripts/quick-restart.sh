#!/usr/bin/env bash
# Quick restart: kill OpenClaw, rebuild TypeScript, start gateway
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Killing OpenClaw processes..."
pkill -f "openclaw.*gateway" 2>/dev/null || true
pkill -f "OpenClaw.app" 2>/dev/null || true
pkill -x "OpenClaw" 2>/dev/null || true
sleep 1

echo "==> Installing dependencies..."
pnpm install

echo "==> Building TypeScript..."
pnpm build

echo "==> Starting gateway..."
node openclaw.mjs gateway run --force &
GATEWAY_PID=$!

sleep 3
if kill -0 "$GATEWAY_PID" 2>/dev/null; then
  echo "OK: Gateway started (pid $GATEWAY_PID)"
  echo "    Logs: openclaw logs --follow"
else
  echo "ERROR: Gateway failed to start"
  exit 1
fi
