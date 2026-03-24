#!/usr/bin/env bash
set -euo pipefail

cp "/Users/alexanderkondrashov/openclaw/openclaw.json.backup-stable" "/Users/alexanderkondrashov/.openclaw/openclaw.json"
cp "/Users/alexanderkondrashov/openclaw/ai.openclaw.gateway.plist.backup-stable" "/Users/alexanderkondrashov/Library/LaunchAgents/ai.openclaw.gateway.plist"
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway"
echo "OpenClaw stable runtime restored and gateway restarted."
