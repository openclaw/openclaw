#!/bin/bash
# OpenClaw Launcher — Start/Restart OpenClaw Gateway
# Kills existing OpenClaw process if running, then starts fresh.

OPENCLAW_DIR="/home/vova/OpenPro"
LOG_FILE="/tmp/openclaw-launcher.log"

export GEMINI_API_KEY="AIzaSyA2rEvczNGcf5FhScyVpOma57pqQghPEkg"
export PATH="$OPENCLAW_DIR/ui/node_modules/.bin:$OPENCLAW_DIR/node_modules/.bin:$PATH"

# Kill existing OpenClaw if running
EXISTING_PID=$(pgrep -f "node dist/entry.js gateway" 2>/dev/null)
if [ -n "$EXISTING_PID" ]; then
    echo "$(date): Stopping existing OpenClaw (PID: $EXISTING_PID)..." >> "$LOG_FILE"
    kill "$EXISTING_PID" 2>/dev/null
    sleep 2
    # Force kill if still alive
    kill -9 "$EXISTING_PID" 2>/dev/null
fi

# Start OpenClaw
echo "$(date): Starting OpenClaw..." >> "$LOG_FILE"
cd "$OPENCLAW_DIR" || exit 1
nohup node dist/entry.js gateway >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$(date): OpenClaw started (PID: $NEW_PID)" >> "$LOG_FILE"

# Show notification
notify-send "🦞 OpenClaw" "Gateway started (PID: $NEW_PID)\nTelegram: @Oleguk_bot\nUI: http://localhost:18790" --icon=network-server 2>/dev/null

echo "OpenClaw started! PID: $NEW_PID"
