#!/usr/bin/env bash
set -euo pipefail

# Deploy script for admin account (requires sudo)
# Usage: deploy-release.sh [worktree-path]
#
# Default: Uses .local/latest symlink (created by build-release.sh)
# Override: Pass a worktree path as argument

# Default to the 'latest' symlink (created by build-release.sh)
DEFAULT_WORKTREE="/Users/petter/Projects/clawdbot/clawdbot/.local/latest"

# Determine source directory (from argument or default)
WORKTREE_PATH="${1:-$DEFAULT_WORKTREE}"
APP_SOURCE="$WORKTREE_PATH/dist/Clawdbot.app"
APP_TARGET="/Applications/Clawdbot.app"

echo "📦 Deploying Clawdbot to /Applications"
echo ""

# Show source info
if [[ -L "$WORKTREE_PATH" ]]; then
  RESOLVED_PATH=$(readlink "$WORKTREE_PATH")
  echo "Source: $WORKTREE_PATH -> $RESOLVED_PATH"
else
  echo "Source: $WORKTREE_PATH"
fi
echo ""

# Verify build exists
if [[ ! -d "$APP_SOURCE" ]]; then
  echo "❌ ERROR: Build not found at $APP_SOURCE"
  echo ""
  echo "Make sure you:"
  echo "1. Run build-release.sh first (creates 'latest' symlink)"
  echo "2. Or pass a specific worktree path: ./deploy-release.sh /path/to/worktree"
  exit 1
fi

# Verify we're not running as petter
if [[ "$(whoami)" == "petter" ]]; then
  echo "⚠️  WARNING: Running as petter user"
  echo "This script is intended for admin account."
  echo ""
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo "🛑 Stopping running instances..."
sudo killall -9 Clawdbot 2>/dev/null || true
sudo killall -9 clawdbot 2>/dev/null || true
sleep 1

echo "🗑️  Removing old installation..."
sudo rm -rf "$APP_TARGET"

echo "📋 Copying new version..."
# Clear quarantine attributes on source first (prevents "operation not permitted")
xattr -cr "$APP_SOURCE" 2>/dev/null || true
sudo cp -R "$APP_SOURCE" "$APP_TARGET"

echo "🔒 Setting ownership and permissions..."
sudo xattr -cr "$APP_TARGET"
sudo chown -R root:wheel "$APP_TARGET"
sudo chmod -R go+rX "$APP_TARGET"
sudo chmod +x "$APP_TARGET/Contents/MacOS/Clawdbot"
sudo chmod +x "$APP_TARGET/Contents/Resources/Relay/clawdbot"

echo "🔗 Installing CLI wrappers..."
# Create wrapper scripts instead of symlinks (symlinks break dirname resolution)
RELAY_DIR="$APP_TARGET/Contents/Resources/Relay"
for bin_path in /usr/local/bin/clawdbot /opt/homebrew/bin/clawdbot; do
  sudo rm -f "$bin_path"
  sudo tee "$bin_path" > /dev/null <<WRAPPER
#!/bin/sh
exec "$RELAY_DIR/clawdbot" "\$@"
WRAPPER
  sudo chmod +x "$bin_path"
done

echo ""
echo "✅ Deployment complete\!"
echo ""
echo "Installed version:"
/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" \
  "$APP_TARGET/Contents/Info.plist" 2>/dev/null || echo "(version info not available)"
echo ""
echo "CLI version:"
# Skip version check - can hang during first run
echo "(run 'clawdbot --version' manually to verify)"
echo ""
echo "Next steps:"
echo "1. Switch back to petter account"
echo "2. Run: clawdbot gateway restart"
echo "3. Run: killall Clawdbot || open /Applications/Clawdbot.app"
echo ""
