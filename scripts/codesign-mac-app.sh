#!/usr/bin/env bash
set -euo pipefail

APP_BUNDLE="${1:-dist/Clawdis.app}"
IDENTITY="${SIGN_IDENTITY:--}"
ENT_TMP=$(mktemp /tmp/clawdis-entitlements.XXXXXX.plist)

if [ ! -d "$APP_BUNDLE" ]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

echo "Using signing identity: $IDENTITY"

cat > "$ENT_TMP" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.hardened-runtime</key>
    <true/>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
PLIST

# clear extended attributes to avoid stale signatures
xattr -cr "$APP_BUNDLE" 2>/dev/null || true

sign_item() {
  local target="$1"
  codesign --force --options runtime --timestamp=none --entitlements "$ENT_TMP" --sign "$IDENTITY" "$target"
}

# Sign main binary and CLI helper if present
if [ -f "$APP_BUNDLE/Contents/MacOS/Clawdis" ]; then
  echo "Signing main binary"; sign_item "$APP_BUNDLE/Contents/MacOS/Clawdis"
fi
if [ -f "$APP_BUNDLE/Contents/MacOS/ClawdisCLI" ]; then
  echo "Signing CLI helper"; sign_item "$APP_BUNDLE/Contents/MacOS/ClawdisCLI"
fi

# Sign any embedded frameworks/dylibs if they ever appear
if [ -d "$APP_BUNDLE/Contents/Frameworks" ]; then
  find "$APP_BUNDLE/Contents/Frameworks" \( -name "*.framework" -o -name "*.dylib" \) -print0 | while IFS= read -r -d '' f; do
    echo "Signing framework: $f"; sign_item "$f"
  done
fi

# Finally sign the bundle
sign_item "$APP_BUNDLE"

rm -f "$ENT_TMP"
echo "Codesign complete for $APP_BUNDLE"
