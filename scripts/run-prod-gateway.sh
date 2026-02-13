#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

START_TUI=0
while (($#)); do
  case "$1" in
    --tui)
      START_TUI=1
      shift
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--tui]"
      echo "  --tui   Start interactive TUI after gateway is healthy"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $(basename "$0") [--tui]" >&2
      exit 2
      ;;
  esac
done

# Ensure this is a real/prod run (not dev/skip-channels mode)
unset OPENCLAW_PROFILE
unset OPENCLAW_SKIP_CHANNELS
unset CLAWDBOT_SKIP_CHANNELS
unset OPENCLAW_SKIP_PROVIDERS

echo "[1/5] Checking model/provider auth..."
node scripts/run-node.mjs models status --check

echo "[2/5] Installing/updating gateway service..."
node scripts/run-node.mjs daemon install --force --runtime node --port 18789

echo "[3/5] Starting gateway service..."
node scripts/run-node.mjs daemon start

echo "[4/5] Waiting for gateway to become ready..."
ready=0
for i in $(seq 1 20); do
  if node scripts/run-node.mjs gateway health >/tmp/openclaw-gateway-health.out 2>/tmp/openclaw-gateway-health.err; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Gateway did not become healthy within 20s."
  echo "Run: node scripts/run-node.mjs daemon status"
  echo "Err tail:"
  tail -n 40 "${HOME}/.openclaw/logs/gateway.err.log" || true
  exit 1
fi

echo "[5/5] Channel status..."
node scripts/run-node.mjs channels status

echo
echo "Done. Channels should now run in background."
echo "Live logs: node scripts/run-node.mjs channels logs"

if [ "$START_TUI" -eq 1 ]; then
  TOKEN="$(node scripts/run-node.mjs config get gateway.auth.token)"
  echo "Starting TUI..."
  exec node scripts/run-node.mjs tui --url ws://127.0.0.1:18789 --token "$TOKEN"
fi
