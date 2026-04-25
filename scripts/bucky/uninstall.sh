#!/usr/bin/env bash
PLIST_LABEL="com.dirgh.bucky-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
launchctl unload "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"
echo "✓ bucky-bridge removed"
