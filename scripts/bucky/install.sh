#!/usr/bin/env bash
# Installs bucky-bridge as a macOS launchd service (auto-starts on login).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON="$SCRIPT_DIR/bucky-bridge.js"
PLIST_LABEL="com.dirgh.bucky-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$HOME/.bucky-bridge"
NODE_BIN="$(which node)"

if [[ ! -f "$DAEMON" ]]; then
  echo "ERROR: $DAEMON not found." >&2
  exit 1
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

# Unload existing if present
launchctl unload "$PLIST_PATH" 2>/dev/null || true

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DAEMON</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardOutPath</key>  <string>$LOG_DIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/bridge.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key> <string>$HOME</string>
    <key>PATH</key> <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl load "$PLIST_PATH"
echo "✓ bucky-bridge installed and running"
echo "  PID:   $(launchctl list | grep $PLIST_LABEL | awk '{print $1}')"
echo "  Logs:  $LOG_DIR/bridge.log"
echo "  Stop:  launchctl unload $PLIST_PATH"
echo "  Tail:  tail -f $LOG_DIR/bridge.log"
