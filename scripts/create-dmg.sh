#!/bin/bash
set -euo pipefail

# Create DMG installer for OpenClaw macOS app
# Usage: ./create-dmg.sh [version]

VERSION="${1:-$(node -p "require('./package.json').version")}"
DMG_NAME="OpenClaw-${VERSION}.dmg"
APP_PATH="./dist/OpenClaw.app"

echo "📦 Creating DMG for OpenClaw v${VERSION}"

# Check if app exists
if [ ! -d "$APP_PATH" ]; then
  echo "❌ OpenClaw.app not found at $APP_PATH"
  echo "Please run 'pnpm mac:package' first"
  exit 1
fi

# Install create-dmg if not available
if ! command -v create-dmg &> /dev/null; then
  echo "📥 Installing create-dmg..."
  npm install -g create-dmg
fi

# Create DMG
echo "🔨 Building DMG installer..."
create-dmg \
  --volname "OpenClaw ${VERSION}" \
  --volicon "./apps/macos/Sources/OpenClaw/Resources/OpenClaw.icns" \
  --background "./apps/macos/Sources/OpenClaw/Resources/dmg-background.png" \
  --window-pos 200 120 \
  --window-size 800 400 \
  --icon-size 100 \
  --icon "OpenClaw.app" 200 190 \
  --hide-extension "OpenClaw.app" \
  --app-drop-link 600 185 \
  "$DMG_NAME" \
  "$APP_PATH"

echo "✅ DMG created: $DMG_NAME"
ls -la "$DMG_NAME"