#!/bin/bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: apps/gpui/scripts/bundle-macos.sh [output.app]"
  echo "Builds an unsigned release bundle; defaults to target/release/OpenClaw GPUI.app."
  exit 0
fi
if [[ "$(uname -s)" != "Darwin" || "$#" -gt 1 ]]; then
  echo "Run on macOS with at most one output bundle path." >&2
  exit 1
fi

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"
metadata="$(cargo metadata --manifest-path "$app_dir/Cargo.toml" --locked --no-deps --format-version 1 | python3 -c '
import json, sys
metadata = json.load(sys.stdin)
package = next(package for package in metadata["packages"] if package["name"] == "openclaw-gpui")
print(package["version"])
print(metadata["target_directory"])
')"
version="${metadata%%$'\n'*}"
target_dir="${metadata#*$'\n'}"
bundle="${1:-$target_dir/release/OpenClaw GPUI.app}"
if [[ "$bundle" != *.app ]]; then
  echo "Output must be an .app bundle path." >&2
  exit 1
fi
if [[ -e "$bundle" || -L "$bundle" ]]; then
  echo "Output already exists: $bundle. Move it aside before rebuilding." >&2
  exit 1
fi

cargo build --manifest-path "$app_dir/Cargo.toml" --locked --release
mkdir -p "$(dirname "$bundle")"
staging="$(mktemp -d "$(dirname "$bundle")/.gpui-bundle.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
staged_bundle="$staging/OpenClaw GPUI.app"
mkdir -p "$staged_bundle/Contents/MacOS" "$staged_bundle/Contents/Resources"
install -m 755 "$target_dir/release/openclaw-gpui" "$staged_bundle/Contents/MacOS/openclaw-gpui"

# Reuse the Mac app artwork and its existing resolutions, without rasterizing a new design.
iconutil --convert iconset --output "$staging/OpenClaw.iconset" \
  "$app_dir/../macos/Sources/OpenClaw/Resources/OpenClaw.icns"
iconutil --convert icns --output "$staged_bundle/Contents/Resources/OpenClaw.icns" \
  "$staging/OpenClaw.iconset"

python3 - "$staged_bundle/Contents/Info.plist" "$version" "$MACOSX_DEPLOYMENT_TARGET" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "wb") as destination:
    plistlib.dump({
        "CFBundleDevelopmentRegion": "en",
        "CFBundleDisplayName": "OpenClaw GPUI",
        "CFBundleExecutable": "openclaw-gpui",
        "CFBundleIconFile": "OpenClaw.icns",
        "CFBundleIdentifier": "ai.openclaw.gpui",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": "OpenClaw GPUI",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": sys.argv[2],
        "CFBundleVersion": sys.argv[2].split("-")[0].split("+")[0],
        "LSMinimumSystemVersion": sys.argv[3],
        "NSHighResolutionCapable": True,
        "NSPrincipalClass": "NSApplication",
    }, destination)
PY
plutil -lint "$staged_bundle/Contents/Info.plist"
mv "$staged_bundle" "$bundle"
echo "Built unsigned bundle: $bundle"
