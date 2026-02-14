#!/usr/bin/env bash
set -euo pipefail

# Paths
DEV_ROOT="/Users/jkneen/Documents/GitHub/atomicbot"
INSTALLED="/Users/jkneen/.nvm/versions/node/v22.14.0/lib/node_modules/openclaw"
UI_DIR="$DEV_ROOT/ui"
BUILD_OUT="$DEV_ROOT/dist/control-ui"
INSTALL_TARGET="$INSTALLED/dist/control-ui"
BACKUP="$INSTALLED/dist/control-ui.bak"

export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:/opt/homebrew/bin:$PATH"

echo "=== OpenClaw UI Patch ==="
echo ""

# 1. Build
echo "→ Building UI..."
cd "$UI_DIR"
pnpm run build 2>&1 | tail -3
echo ""

# 2. Verify build output
if [ ! -f "$BUILD_OUT/index.html" ]; then
  echo "✗ Build output not found at $BUILD_OUT"
  exit 1
fi
echo "→ Build OK: $(du -sh "$BUILD_OUT" | cut -f1) in $BUILD_OUT"

# 3. Backup installed version (first time only)
if [ ! -d "$BACKUP" ]; then
  echo "→ Backing up installed UI to control-ui.bak..."
  cp -R "$INSTALL_TARGET" "$BACKUP"
else
  echo "→ Backup already exists (control-ui.bak)"
fi

# 4. Patch
echo "→ Patching installed version..."
rm -rf "$INSTALL_TARGET"
cp -R "$BUILD_OUT" "$INSTALL_TARGET"
echo "→ Patched: $(du -sh "$INSTALL_TARGET" | cut -f1)"

# 5. Restart live gateway
echo ""
echo "→ Restarting live gateway..."
cd "$DEV_ROOT"
PID=$(/usr/sbin/lsof -i :18789 -P -t 2>/dev/null | head -1 || true)
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null || true
  sleep 2
  echo "  Killed PID $PID"
fi

# Let the system service restart it, or start manually:
# openclaw gateway start
echo ""
echo "=== Done ==="
echo "Live gateway UI patched. Refresh http://127.0.0.1:18789"
echo "To restore: cp -R $BACKUP $INSTALL_TARGET"
