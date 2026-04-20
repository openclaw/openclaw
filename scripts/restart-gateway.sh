#!/bin/bash
# A simple, reliable gateway restart script that doesn't depend on a full build.
# Uses launchctl to directly manage the service.

PLIST_PATH="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
SERVICE_ID="gui/$(id -u)/ai.openclaw.gateway"

echo "==> Stopping OpenClaw Gateway service..."
if launchctl list | grep -q "ai.openclaw.gateway"; then
  launchctl bootout "$SERVICE_ID"
  echo "Service stopped."
else
  echo "Service not running."
fi

echo "==> Starting OpenClaw Gateway service..."
launchctl bootstrap "$SERVICE_ID" "$PLIST_PATH"

echo "==> Waiting for gateway to initialize..."
sleep 5

openclaw gateway status
