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

echo "📦 Ensuring deps (pnpm install)"
(cd "$ROOT_DIR" && pnpm install --no-frozen-lockfile --config.node-linker=hoisted)
echo "📦 Building JS (pnpm exec tsc)"
(cd "$ROOT_DIR" && pnpm exec tsc -p tsconfig.json)

cd "$ROOT_DIR/apps/macos"

echo "🔨 Building $PRODUCT (debug)"
swift build -c debug --product "$PRODUCT" --product "${PRODUCT}CLI" --build-path "$BUILD_PATH"

BIN="$BUILD_PATH/debug/$PRODUCT"
CLI_BIN="$BUILD_PATH/debug/ClawdisCLI"
echo "🧹 Cleaning old app bundle"
rm -rf "$APP_ROOT"
mkdir -p "$APP_ROOT/Contents/MacOS"
mkdir -p "$APP_ROOT/Contents/Resources"
mkdir -p "$APP_ROOT/Contents/Resources/Relay"

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

echo "📦 Copying WebChat resources"
rsync -a "$ROOT_DIR/apps/macos/Sources/Clawdis/Resources/WebChat" "$APP_ROOT/Contents/Resources/"

RELAY_DIR="$APP_ROOT/Contents/Resources/Relay"
BUN_SRC="${BUN_PATH:-$(command -v bun || true)}"
if [ -z "$BUN_SRC" ] || [ ! -x "$BUN_SRC" ]; then
  echo "bun binary not found (set BUN_PATH to override)" >&2
  exit 1
fi

echo "🧰 Staging relay runtime (bun + dist + node_modules)"
cp "$BUN_SRC" "$RELAY_DIR/bun"
chmod +x "$RELAY_DIR/bun"
rsync -a --delete --exclude "Clawdis.app" "$ROOT_DIR/dist/" "$RELAY_DIR/dist/"
cp "$ROOT_DIR/package.json" "$RELAY_DIR/"
cp "$ROOT_DIR/pnpm-lock.yaml" "$RELAY_DIR/"
if [ -f "$ROOT_DIR/.npmrc" ]; then
  cp "$ROOT_DIR/.npmrc" "$RELAY_DIR/"
fi

echo "📦 Installing prod node_modules into bundle via temp project"
TMP_DEPLOY=$(mktemp -d /tmp/clawdis-deps.XXXXXX)
cp "$ROOT_DIR/package.json" "$TMP_DEPLOY/"
cp "$ROOT_DIR/pnpm-lock.yaml" "$TMP_DEPLOY/"
[ -f "$ROOT_DIR/.npmrc" ] && cp "$ROOT_DIR/.npmrc" "$TMP_DEPLOY/"
PNPM_STORE_DIR="$TMP_DEPLOY/.pnpm-store" \
PNPM_HOME="$HOME/Library/pnpm" \
pnpm install \
  --prod \
  --force \
  --no-frozen-lockfile \
  --ignore-scripts=false \
  --config.enable-pre-post-scripts=true \
  --config.ignore-workspace-root-check=true \
  --config.shared-workspace-lockfile=false \
  --config.node-linker=hoisted \
  --lockfile-dir "$TMP_DEPLOY" \
  --dir "$TMP_DEPLOY"
PNPM_STORE_DIR="$TMP_DEPLOY/.pnpm-store" \
PNPM_HOME="$HOME/Library/pnpm" \
pnpm rebuild sharp --config.ignore-workspace-root-check=true --dir "$TMP_DEPLOY"
rsync -a "$TMP_DEPLOY/node_modules/" "$RELAY_DIR/node_modules/"

# Keep only the arm64 macOS sharp vendor payloads to shrink the bundle
SHARP_VENDOR_DIR="$RELAY_DIR/node_modules/@img"
if [ -d "$SHARP_VENDOR_DIR" ]; then
  find "$SHARP_VENDOR_DIR" -maxdepth 1 -type d -name "sharp-*" \
    ! -name "sharp-darwin-arm64" \
    ! -name "sharp-libvips-darwin-arm64" -exec rm -rf {} +
fi

# Prune obvious dev/build tooling to keep size down
rm -rf \
  "$RELAY_DIR/node_modules/.bin"/vite \
  "$RELAY_DIR/node_modules/.bin"/rolldown \
  "$RELAY_DIR/node_modules/.bin"/biome \
  "$RELAY_DIR/node_modules/.bin"/vitest \
  "$RELAY_DIR/node_modules/.bin"/tsc \
  "$RELAY_DIR/node_modules/.bin"/tsx 2>/dev/null || true
rm -rf \
  "$RELAY_DIR/node_modules"/{vite,rolldown,vitest,ts-node,ts-node-dev,typescript,@types,docx-preview,jszip,lucide,ollama} 2>/dev/null || true
rm -rf "$TMP_DEPLOY"

if [ -f "$CLI_BIN" ]; then
  echo "🔧 Copying CLI helper"
  cp "$CLI_BIN" "$APP_ROOT/Contents/MacOS/ClawdisCLI"
  chmod +x "$APP_ROOT/Contents/MacOS/ClawdisCLI"
fi

echo "⏹  Stopping any running Clawdis"
killall -q Clawdis 2>/dev/null || true

echo "🔏 Signing bundle (auto-selects signing identity if SIGN_IDENTITY is unset)"
"$ROOT_DIR/scripts/codesign-mac-app.sh" "$APP_ROOT"

echo "✅ Bundle ready at $APP_ROOT"
