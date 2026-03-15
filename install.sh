#!/usr/bin/env bash
# install.sh — Deploy Chrome Cleanup Daemon for OpenClaw
# Run as: bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.openclaw/browser"
LOG_DIR="$HOME/.openclaw/logs"

# Detect platform
case "$(uname -s)" in
    Linux*)  PLATFORM="linux" ;;
    Darwin*) PLATFORM="macos" ;;
    *)       echo "Unsupported platform: $(uname -s)"; exit 1 ;;
esac

echo "[chrome-cleanup] Installing to $INSTALL_DIR (platform=$PLATFORM)..."

mkdir -p "$INSTALL_DIR" "$LOG_DIR"

# Install script and config
cp "$SCRIPT_DIR/scripts/chrome-cleanup.sh" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/chrome-cleanup.sh"

# Only install config if not already present (preserve user modifications)
if [[ ! -f "$INSTALL_DIR/chrome-cleanup.conf" ]]; then
    cp "$SCRIPT_DIR/scripts/chrome-cleanup.conf" "$INSTALL_DIR/"
    echo "[chrome-cleanup] Config installed (fresh)"
else
    echo "[chrome-cleanup] Config already exists — skipping (preserving user settings)"
    echo "  To reset: cp $SCRIPT_DIR/scripts/chrome-cleanup.conf $INSTALL_DIR/"
fi

if [[ "$PLATFORM" == "linux" ]]; then
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"

    cp "$SCRIPT_DIR/scripts/systemd/chrome-cleanup.service" "$SYSTEMD_DIR/"
    systemctl --user daemon-reload
    systemctl --user enable chrome-cleanup.service
    systemctl --user restart chrome-cleanup.service

    echo "[chrome-cleanup] Service status:"
    # Avoid SIGPIPE under set -euo pipefail: capture output first, then truncate
    _svc_status=$(systemctl --user status chrome-cleanup.service --no-pager 2>&1 || true)
    echo "$_svc_status" | head -6
    unset _svc_status

elif [[ "$PLATFORM" == "macos" ]]; then
    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    PLIST_NAME="com.openclaw.chrome-cleanup.plist"
    PLIST_DST="$LAUNCHD_DIR/$PLIST_NAME"

    mkdir -p "$LAUNCHD_DIR"

    # Unload existing agent if running
    if launchctl list | grep -q "com.openclaw.chrome-cleanup" 2>/dev/null; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
    fi

    # Replace HOME_PLACEHOLDER with actual home directory
    sed "s|HOME_PLACEHOLDER|$HOME|g" "$SCRIPT_DIR/scripts/launchd/$PLIST_NAME" > "$PLIST_DST"
    launchctl load "$PLIST_DST"

    echo "[chrome-cleanup] launchd agent loaded: com.openclaw.chrome-cleanup"
    echo "  Check: launchctl list | grep chrome-cleanup"
fi

echo ""
echo "[chrome-cleanup] Installation complete."
echo "  Status:  $INSTALL_DIR/chrome-cleanup.sh status"
echo "  Logs:    tail -f $LOG_DIR/chrome-cleanup.log"
echo "  Config:  $INSTALL_DIR/chrome-cleanup.conf"
if [[ "$PLATFORM" == "linux" ]]; then
    echo "  Service: systemctl --user {status|stop|restart} chrome-cleanup.service"
else
    echo "  Service: launchctl {list|unload|load} ~/Library/LaunchAgents/com.openclaw.chrome-cleanup.plist"
fi
