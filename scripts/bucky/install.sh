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

# ── Claude Code hooks ─────────────────────────────────────────────────────────
echo "Installing Claude Code PostToolUse hook..."
HOOK_SRC="$SCRIPT_DIR/hooks/post-tool-use.sh"
HOOK_DST="$HOME/.claude/hooks/post-tool-use.sh"

if [[ ! -f "$HOOK_SRC" ]]; then
  echo "ERROR: $HOOK_SRC not found" >&2
  exit 1
fi

mkdir -p "$HOME/.claude/hooks"
cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"
echo "  Installed: $HOOK_DST"

# Register PostToolUse hook in ~/.claude/settings.json
SETTINGS="$HOME/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
  python3 - "$SETTINGS" "$HOOK_DST" << 'PYEOF'
import json, sys

settings_path = sys.argv[1]
hook_path = sys.argv[2]

with open(settings_path) as f:
    settings = json.load(f)

hooks = settings.setdefault("hooks", {})
post_hooks = hooks.setdefault("PostToolUse", [])

hook_cmd = {"type": "command", "command": hook_path}
hook_entry = {"matcher": "", "hooks": [hook_cmd]}
already_registered = any(
    any(h.get("command") == hook_path for h in entry.get("hooks", []))
    for entry in post_hooks
)

if not already_registered:
    post_hooks.append(hook_entry)
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=4)
    print(f"  Registered PostToolUse hook in {settings_path}")
else:
    print("  PostToolUse hook already registered — skipped")
PYEOF
else
  echo "  WARNING: $SETTINGS not found — create it by running Claude Code first"
fi

launchctl load "$PLIST_PATH"
echo "✓ bucky-bridge installed and running"
echo "  PID:   $(launchctl list | grep $PLIST_LABEL | awk '{print $1}')"
echo "  Logs:  $LOG_DIR/bridge.log"
echo "  Stop:  launchctl unload $PLIST_PATH"
echo "  Tail:  tail -f $LOG_DIR/bridge.log"
