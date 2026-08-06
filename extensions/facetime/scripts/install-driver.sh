#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
installed_driver="/Library/Audio/Plug-Ins/HAL/OpenClawBridge.driver"
recipe="facetime-paired-v1"
version="0.7.1"

driver_status_at() {
  target_driver=$1
  if ! test -d "$target_driver"; then
    printf 'missing\n'
    return
  fi
  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
    "$target_driver/Contents/Info.plist" 2>/dev/null || true)
  installed_recipe=$(/usr/libexec/PlistBuddy -c 'Print :OpenClawDriverRecipe' \
    "$target_driver/Contents/Info.plist" 2>/dev/null || true)
  installed_version=$(/usr/libexec/PlistBuddy -c 'Print :OpenClawBlackHoleVersion' \
    "$target_driver/Contents/Info.plist" 2>/dev/null || true)
  if test "$bundle_id" != "ai.openclaw.BlackHoleBridge" ||
     test "$installed_recipe" != "$recipe" ||
     test "$installed_version" != "$version"; then
    printf 'outdated\n'
    return
  fi
  if ! /usr/bin/codesign --verify --strict "$target_driver" >/dev/null 2>&1; then
    printf 'invalid\n'
    return
  fi
  printf 'current\n'
}

driver_status() {
  driver_status_at "$installed_driver"
}

case "${1:-}" in
  --status)
    driver_status
    exit 0
    ;;
  ""|--ensure)
    ;;
  *)
    echo "Usage: $0 [--status|--ensure]" >&2
    exit 2
    ;;
esac

if test "$(driver_status)" = "current"; then
  printf 'OpenClaw-Mic and OpenClaw-Feed are already current.\n'
  exit 0
fi

/usr/bin/osascript "$here/scripts/install-driver.applescript" \
  "$here/scripts/install-driver-root.sh"
if test "$(driver_status)" != "current"; then
  echo "OpenClaw paired audio driver installation did not verify successfully." >&2
  exit 1
fi

printf 'Installed OpenClaw-Mic and OpenClaw-Feed. Reconnect any active FaceTime call.\n'
