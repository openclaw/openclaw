#!/usr/bin/env bash
set -euo pipefail

# Dynamic PATH setup - detect common package manager locations
if command -v brew >/dev/null 2>&1; then
  export PATH="$(brew --prefix)/bin:$PATH"
fi

# Ensure node/npm/pnpm are in PATH from nvm if available
if [ -f "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
fi

# Paths
DEV_ROOT="$(cd "$(dirname "$0")" && pwd)"
# Dynamically find OpenClaw installation
if command -v openclaw >/dev/null 2>&1; then
  # Find openclaw binary location and derive installation path
  OPENCLAW_BIN="$(which openclaw)"
  if [[ "$OPENCLAW_BIN" == *"/node_modules/.bin/"* ]]; then
    # Global npm/pnpm installation
    INSTALLED="$(dirname "$(dirname "$OPENCLAW_BIN")")/openclaw"
  else
    # Direct binary installation - try common locations
    INSTALLED="$(npm root -g 2>/dev/null || echo "/usr/local/lib/node_modules")/openclaw"
  fi
else
  echo "✗ openclaw command not found. Please install OpenClaw first."
  exit 1
fi
UI_DIR="$DEV_ROOT/ui"
BUILD_OUT="$DEV_ROOT/dist/control-ui"
INSTALL_TARGET="$INSTALLED/dist/control-ui"
BACKUP="$INSTALLED/dist/control-ui.bak"

echo "=== OpenClaw UI Patch ==="
echo ""

# Verify installed version exists
if [ ! -d "$INSTALLED" ]; then
  echo "✗ OpenClaw not found at $INSTALLED"
  exit 1
fi

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
# Try to find and restart gateway using portable approach
PID=""
if command -v lsof >/dev/null 2>&1; then
  PID=$(lsof -i :18789 -P -t 2>/dev/null | head -1 || true)
fi

if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null || true
  sleep 2
  echo "  Killed PID $PID. The service manager should restart it."
else
  echo "  No process found on :18789. Using 'openclaw gateway restart'..."
  if command -v openclaw >/dev/null 2>&1; then
    if ! openclaw gateway restart; then
      echo "  'openclaw gateway restart' failed. Attempting to start it..."
      if ! openclaw gateway start; then
        echo "  'openclaw gateway start' also failed. Please start the gateway manually."
      fi
    fi
  else
    echo "  'openclaw' command not found. Cannot restart gateway."
  fi
fi

echo ""
echo "=== Done ==="
echo "Live gateway UI patched. Refresh http://127.0.0.1:18789"
echo "To restore: cp -R $BACKUP $INSTALL_TARGET"
