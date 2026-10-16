#!/bin/bash
set -euo pipefail

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
mkdir -p "$host_app/Contents/MacOS" "$host_app/Contents/Resources"
cp "$host_helper" "$host_app/Contents/MacOS/OpenClawRecoveryTestHost"
chmod 0755 "$host_app/Contents/MacOS/OpenClawRecoveryTestHost"

# Bundle.main must identify the test helper's real .app, never a mocked bundle.
python3 - "$host_repo/dist/build-info.json" "$host_app/Contents/Info.plist" "$(git -C "$host_repo" rev-parse HEAD)" <<'PY'
import json, plistlib, sys
with open(sys.argv[1]) as source:
    build = json.load(source)
if build["commit"] != sys.argv[3]:
    raise SystemExit("The runtime build must match this exact candidate source.")
with open(sys.argv[2], "wb") as destination:
    plistlib.dump({
        "CFBundleExecutable": "OpenClawRecoveryTestHost",
        "CFBundleIdentifier": "ai.openclaw.mac.recovery-fixture",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": build["version"],
        "CFBundleVersion": "1",
        "OpenClawGitCommit": build["commit"],
        "OpenClawBuildTimestamp": build["builtAt"],
        "OpenClawRuntimeBuildID": build["buildId"],
        "LSUIElement": True,
    }, destination)
PY
/bin/bash "$host_repo/scripts/stage-mac-runtime.sh" "$host_app/Contents/Resources/runtime" "$(uname -m)"

# The existing resource owner joins both fresh hosts, then retires its unique service.
# Retain a failed host's payload beside the native diagnostic output for investigation.
DYLD_FRAMEWORK_PATH="$host_platform/Library/Frameworks:$host_platform/Library/PrivateFrameworks" \
DYLD_LIBRARY_PATH="$host_build:$host_platform/usr/lib" \
node "$host_repo/scripts/test-macos-native.mts" app-host "$host_app" "$host_tests" \
  'BundledRecoveryCompositionTests/`ordinary retry`' 'BundledRecoveryCompositionTests/relaunch'
rm -rf "$host_root"
