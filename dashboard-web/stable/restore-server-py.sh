#!/usr/bin/env bash
set -euo pipefail

USER_NAME="sergio"
USER_HOME="/home/sergio"

STABLE_DIR="$USER_HOME/.openclaw/workspace/dashboard-web/stable"
LIVE_FILE="$USER_HOME/.openclaw/workspace/dashboard-web/server.py"
CANONICAL_FILE="$STABLE_DIR/server.py.current-ok"
SERVICE_NAME="context-dashboard-web.service"

test -f "$CANONICAL_FILE"

cp -a "$CANONICAL_FILE" "$LIVE_FILE"
chown "$USER_NAME:$USER_NAME" "$LIVE_FILE"
chmod 0755 "$LIVE_FILE"

sudo -u "$USER_NAME" -H env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart "$SERVICE_NAME"
sleep 2

echo "restore completo"
sha256sum "$LIVE_FILE" "$CANONICAL_FILE"
sudo -u "$USER_NAME" -H env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user --no-pager --full status "$SERVICE_NAME" | sed -n '1,80p'
