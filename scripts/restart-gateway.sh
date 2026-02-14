#!/usr/bin/env bash
# Restart OpenClaw gateway (ops-safe, no rebuild)
# Use this for daily ops when gateway is dead or WhatsApp is disconnected.
# For dev work after code changes, use restart-mac.sh instead.

set -euo pipefail

echo "==> Restarting OpenClaw gateway..."

# 1. Restart the LaunchAgent
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# 2. Wait for gateway to become reachable (max 15s)
echo "==> Waiting for gateway..."
GATEWAY_UP=0
for i in {1..15}; do
  if openclaw gateway probe 2>&1 | grep -q "Reachable: yes"; then
    echo "✓ Gateway is up"
    GATEWAY_UP=1
    break
  fi
  sleep 1
done

if [[ $GATEWAY_UP -eq 0 ]]; then
  echo "⚠ Gateway did not come up within 15 seconds"
  echo "   Check logs: tail ~/.openclaw/logs/gateway.log"
  exit 1
fi

# 3. Check channel status (especially WhatsApp)
echo ""
echo "==> Channel status:"
openclaw channels status --probe 2>&1 | grep -v "^\[plugins\]" || true

# 4. Show gateway info
echo ""
echo "==> Gateway info:"
openclaw status 2>&1 | grep -E "Gateway|Tailscale|Channels" | grep -v "^\[plugins\]" || true

echo ""
echo "✓ Restart complete"
echo ""
echo "Dashboard: http://127.0.0.1:18789/"
