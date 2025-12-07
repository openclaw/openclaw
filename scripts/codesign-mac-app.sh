#!/usr/bin/env bash
set -euo pipefail

APP_BUNDLE="${1:-dist/Clawdis.app}"
IDENTITY="${SIGN_IDENTITY:-}"
ENT_TMP=$(mktemp -t clawdis-entitlements)

if [ ! -d "$APP_BUNDLE" ]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

select_identity() {
  local preferred available first

  # Prefer a Developer ID Application cert.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Developer ID Application/ { print $2; exit }')"

  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Fallback to the first valid signing identity.
  available="$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*\"\\(.*\\)\"/\\1/p')"

  if [ -n "$available" ]; then
    first="$(printf '%s\n' "$available" | head -n1)"
    echo "$first"
    return
  fi

  return 1
}

if [ -z "$IDENTITY" ]; then
  if ! IDENTITY="$(select_identity)"; then
    echo "ERROR: No signing identity found. Set SIGN_IDENTITY to a valid codesigning certificate." >&2
    exit 1
  fi
fi

echo "Using signing identity: $IDENTITY"

cat > "$ENT_TMP" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.hardened-runtime</key>
    <true/>
    <key>com.apple.security.cs.allow-jit</key>
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

sign_plain_item() {
  local target="$1"
  codesign --force --options runtime --timestamp=none --sign "$IDENTITY" "$target"
}

# Sign main binary and CLI helper if present
if [ -f "$APP_BUNDLE/Contents/MacOS/Clawdis" ]; then
  echo "Signing main binary"; sign_item "$APP_BUNDLE/Contents/MacOS/Clawdis"
fi
if [ -f "$APP_BUNDLE/Contents/MacOS/ClawdisCLI" ]; then
  echo "Signing CLI helper"; sign_item "$APP_BUNDLE/Contents/MacOS/ClawdisCLI"
fi

# Sign bundled relay runtime bits (bun, native addons, libvips dylibs)
if [ -d "$APP_BUNDLE/Contents/Resources/Relay" ]; then
  find "$APP_BUNDLE/Contents/Resources/Relay" -type f \( -name "bun" -o -name "*.node" -o -name "*.dylib" \) -print0 | while IFS= read -r -d '' f; do
    echo "Signing relay payload: $f"; sign_item "$f"
  done
fi

# Sign Sparkle deeply if present
SPARKLE="$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE" ]; then
  echo "Signing Sparkle framework and helpers"
  sign_plain_item "$SPARKLE/Versions/B/Sparkle"
  sign_plain_item "$SPARKLE/Versions/B/Autoupdate"
  sign_plain_item "$SPARKLE/Versions/B/Updater.app/Contents/MacOS/Updater"
  sign_plain_item "$SPARKLE/Versions/B/Updater.app"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Downloader.xpc"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer"
  sign_plain_item "$SPARKLE/Versions/B/XPCServices/Installer.xpc"
  sign_plain_item "$SPARKLE/Versions/B"
  sign_plain_item "$SPARKLE"
fi

# Sign any other embedded frameworks/dylibs
if [ -d "$APP_BUNDLE/Contents/Frameworks" ]; then
  find "$APP_BUNDLE/Contents/Frameworks" \( -name "*.framework" -o -name "*.dylib" \) ! -path "*Sparkle.framework*" -print0 | while IFS= read -r -d '' f; do
    echo "Signing framework: $f"; sign_plain_item "$f"
  done
fi

# Finally sign the bundle
sign_item "$APP_BUNDLE"

rm -f "$ENT_TMP"
echo "Codesign complete for $APP_BUNDLE"
