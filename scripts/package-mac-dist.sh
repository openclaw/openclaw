#!/usr/bin/env bash
set -euo pipefail

# Build the mac app bundle, then create a zip (Sparkle) + styled DMG (humans).
#
# Output:
# - dist/Clawdis.app
# - dist/Clawdis-<version>.zip
# - dist/Clawdis-<version>.dmg

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT_DIR/scripts/package-mac-app.sh"

APP="$ROOT_DIR/dist/Clawdis.app"
if [[ ! -d "$APP" ]]; then
  echo "Error: missing app bundle at $APP" >&2
  exit 1
fi

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
ZIP="$ROOT_DIR/dist/Clawdis-$VERSION.zip"
DMG="$ROOT_DIR/dist/Clawdis-$VERSION.dmg"
NOTARY_ZIP="$ROOT_DIR/dist/Clawdis-$VERSION.notary.zip"
NOTARIZE="${NOTARIZE:-0}"

if [[ "$NOTARIZE" == "1" ]]; then
  echo "📦 Notary zip: $NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$NOTARY_ZIP"
  STAPLE_APP_PATH="$APP" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$NOTARY_ZIP"
  rm -f "$NOTARY_ZIP"
fi

echo "📦 Zip: $ZIP"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "💿 DMG: $DMG"
"$ROOT_DIR/scripts/create-dmg.sh" "$APP" "$DMG"

if [[ "$NOTARIZE" == "1" ]]; then
  "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$DMG"
fi
