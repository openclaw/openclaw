#!/usr/bin/env bash
set -euo pipefail

# Build and bundle Clawdis into a minimal .app we can open.
# Outputs to dist/Clawdis.app

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="$ROOT_DIR/dist/Clawdis.app"
BUILD_PATH="$ROOT_DIR/apps/macos/.build"
PRODUCT="Clawdis"
BUNDLE_ID="${BUNDLE_ID:-com.steipete.clawdis.debug}"
PKG_VERSION="$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
BUILD_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(cd "$ROOT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
APP_VERSION="${APP_VERSION:-$PKG_VERSION}"
APP_BUILD="${APP_BUILD:-$PKG_VERSION}"

cd "$ROOT_DIR/apps/macos"

echo "🔨 Building $PRODUCT (debug)"
swift build -c debug --product "$PRODUCT" --product "${PRODUCT}CLI" --build-path "$BUILD_PATH"

BIN="$BUILD_PATH/debug/$PRODUCT"
CLI_BIN="$BUILD_PATH/debug/ClawdisCLI"
echo "🧹 Cleaning old app bundle"
rm -rf "$APP_ROOT"
mkdir -p "$APP_ROOT/Contents/MacOS"
mkdir -p "$APP_ROOT/Contents/Resources"

echo "📄 Writing Info.plist"
cat > "$APP_ROOT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleShortVersionString</key>
    <string>${APP_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${APP_BUILD}</string>
    <key>CFBundleName</key>
    <string>Clawdis</string>
    <key>CFBundleExecutable</key>
    <string>Clawdis</string>
    <key>CFBundleIconFile</key>
    <string>Clawdis</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>15.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>ClawdisBuildTimestamp</key>
    <string>${BUILD_TS}</string>
    <key>ClawdisGitCommit</key>
    <string>${GIT_COMMIT}</string>
    <key>NSUserNotificationUsageDescription</key>
    <string>Clawdis needs notification permission to show alerts for agent actions.</string>
    <key>NSScreenCaptureDescription</key>
    <string>Clawdis captures the screen when the agent needs screenshots for context.</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>Clawdis needs the mic for Voice Wake tests and agent audio capture.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>Clawdis uses speech recognition to detect your Voice Wake trigger phrase.</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>Clawdis needs Automation (AppleScript) permission to drive Terminal and other apps for agent actions.</string>
</dict>
</plist>
PLIST

echo "🚚 Copying binary"
cp "$BIN" "$APP_ROOT/Contents/MacOS/Clawdis"
chmod +x "$APP_ROOT/Contents/MacOS/Clawdis"

echo "🖼  Copying app icon"
cp "$ROOT_DIR/apps/macos/Sources/Clawdis/Resources/Clawdis.icns" "$APP_ROOT/Contents/Resources/Clawdis.icns"

if [ -f "$CLI_BIN" ]; then
  echo "🔧 Copying CLI helper"
  cp "$CLI_BIN" "$APP_ROOT/Contents/MacOS/ClawdisCLI"
  chmod +x "$APP_ROOT/Contents/MacOS/ClawdisCLI"
fi

echo "⏹  Stopping any running Clawdis"
killall -q Clawdis 2>/dev/null || true

echo "🔏 Signing bundle (ad-hoc by default; set SIGN_IDENTITY for real cert)"
SIGN_IDENTITY="${SIGN_IDENTITY:--}" "$ROOT_DIR/scripts/codesign-mac-app.sh" "$APP_ROOT"

echo "✅ Bundle ready at $APP_ROOT"
