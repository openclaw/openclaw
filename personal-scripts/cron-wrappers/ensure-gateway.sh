#!/bin/bash
# Ensure gateway is running before sending notifications

MOLTBOT="/Users/steve/Library/pnpm/moltbot"

ensure_gateway() {
    # Check if gateway is reachable
    if ! lsof -i :18789 >/dev/null 2>&1; then
        echo "Gateway not running, starting daemon..."
        "$MOLTBOT" daemon start >/dev/null 2>&1
        sleep 5
    fi
}
