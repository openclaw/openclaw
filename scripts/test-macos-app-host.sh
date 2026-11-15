#!/bin/bash
set -euo pipefail

case "${1:-}" in
  "") host_filters=('BundledRecoveryCompositionTests/`ordinary retry`' 'ClientCredentialStartupCompositionTests' 'BundledRecoveryCompositionTests/relaunch') ;;
  --credential-startup-only) host_filters=('ClientCredentialStartupCompositionTests') ;;
  *) echo "Usage: $0 [--credential-startup-only]" >&2; exit 2 ;;
esac
[[ "$#" -le 1 ]]

# The caller owns a disposable macOS worker and a completed exact-source build.
[[ "${CI:-}" == "true" && "${GITHUB_ACTIONS:-}" == "true" && "${RUNNER_OS:-}" == "macOS" && -n "${RUNNER_TEMP:-}" ]]
host_repo="$(cd "$(dirname "$0")/.." && pwd -P)"
host_build="$(cd "$host_repo/apps/macos/.build/debug" && pwd -P)"
host_swift="$(xcrun --find swift)"
host_platform="$(xcrun --sdk macosx --show-sdk-platform-path)/Developer"
host_helper="$(dirname "$host_swift")/../libexec/swift/pm/swiftpm-testing-helper"
host_tests="$host_build/OpenClawPackageTests.xctest/Contents/MacOS/OpenClawPackageTests"
[[ -x "$host_helper" && -f "$host_tests" && -f "$host_repo/dist/build-info.json" ]]
host_root="$(mktemp -d "$RUNNER_TEMP/openclaw-recovery-host.XXXXXX")"
host_app="$host_root/OpenClawRecoveryFixture.app"
host_startup_app="$host_root/OpenClawStartupFixture.app"
mkdir -p "$host_app/Contents/MacOS" "$host_app/Contents/Resources"
mkdir -p "$host_startup_app/Contents/MacOS" "$host_startup_app/Contents/Resources" "$host_startup_app/Contents/Frameworks"
cp "$host_helper" "$host_app/Contents/MacOS/OpenClawRecoveryTestHost"
chmod 0755 "$host_app/Contents/MacOS/OpenClawRecoveryTestHost"
cp "$host_build/OpenClaw" "$host_startup_app/Contents/MacOS/OpenClaw"
cp -R "$host_build/Sparkle.framework" "$host_startup_app/Contents/Frameworks/"
for host_resource in "$host_build"/*.bundle; do
  [[ -d "$host_resource" ]] && cp -R "$host_resource" "$host_startup_app/Contents/Resources/"
done

# Bundle.main must identify the test helper's real .app, never a mocked bundle.
python3 - "$host_repo/dist/build-info.json" "$host_app/Contents/Info.plist" "$(git -C "$host_repo" rev-parse HEAD)" \
  "$host_repo/apps/macos/Sources/OpenClaw/Resources/Info.plist" "$host_startup_app/Contents/Info.plist" <<'PY'
import json, plistlib, sys
with open(sys.argv[1]) as source:
    build = json.load(source)
if build["commit"] != sys.argv[3]:
    raise SystemExit("The runtime build must match this exact candidate source.")
metadata = {
        "CFBundleExecutable": "OpenClawRecoveryTestHost",
        "CFBundleIdentifier": "ai.openclaw.mac.recovery-fixture",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": build["version"],
        "CFBundleVersion": "1",
        "OpenClawGitCommit": build["commit"],
        "OpenClawBuildTimestamp": build["builtAt"],
        "OpenClawRuntimeBuildID": build["buildId"],
        "LSUIElement": True,
    }
with open(sys.argv[2], "wb") as destination:
    plistlib.dump(metadata, destination)
with open(sys.argv[4], "rb") as source:
    startup = plistlib.load(source)
startup.update(metadata)
startup.update(CFBundleExecutable="OpenClaw", CFBundleIdentifier="ai.openclaw.mac.credential-startup-fixture")
with open(sys.argv[5], "wb") as destination:
    plistlib.dump(startup, destination)
PY
/bin/bash "$host_repo/scripts/stage-mac-runtime.sh" "$host_app/Contents/Resources/runtime" "$(uname -m)"
cp -R "$host_app/Contents/Resources/runtime" "$host_startup_app/Contents/Resources/runtime"

# Match the production bundle's framework search path on this staged debug copy.
host_startup_executable="$host_startup_app/Contents/MacOS/OpenClaw"
host_startup_load_commands="$(/usr/bin/otool -l "$host_startup_executable")"
if ! printf '%s\n' "$host_startup_load_commands" | /usr/bin/awk '
  $1 == "cmd" { rpath = $2 == "LC_RPATH" }
  rpath && $1 == "path" && $2 == "@executable_path/../Frameworks" { found = 1 }
  END { exit !found }
'; then
  /usr/bin/codesign --remove-signature "$host_startup_executable"
  /usr/bin/install_name_tool -add_rpath '@executable_path/../Frameworks' "$host_startup_executable"
fi
/usr/bin/codesign --force --sign - --timestamp=none "$host_startup_executable"
/usr/bin/codesign --verify --strict "$host_startup_executable"

# The existing resource owner joins each fresh host, then retires its unique service.
# Retain a failed host's payload beside the native diagnostic output for investigation.
DYLD_FRAMEWORK_PATH="$host_platform/Library/Frameworks:$host_platform/Library/PrivateFrameworks" \
DYLD_LIBRARY_PATH="$host_build:$host_platform/usr/lib" \
node "$host_repo/scripts/test-macos-native.mts" app-host "$host_app" "$host_tests" \
  "${host_filters[@]}"
rm -rf "$host_root"
