#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/ios-fastlane.sh"

if [[ "${CI:-}" == "true" && "${OPENCLAW_SNAPSHOT_SKIP_WATCH:-}" != "1" ]]; then
  echo "Runner image: ${ImageOS:-unknown} / ${ImageVersion:-unknown}"
  xcodebuild -version
  xcrun simctl runtime scan-and-mount
  xcrun simctl list runtimes
  watch_version="$(xcrun --sdk watchsimulator --show-sdk-version)"
  # Xcode exits 70 when a requested runtime is already downloaded.
  if ! xcrun simctl list runtimes --json | node -e '
    const runtimes = JSON.parse(require("node:fs").readFileSync(0, "utf8")).runtimes;
    process.exit(runtimes.some(runtime => runtime.isAvailable &&
      runtime.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.watchOS-") &&
      runtime.version === process.argv[1]) ? 0 : 1);
  ' "$watch_version"; then
    xcodebuild -downloadPlatform watchOS -buildVersion "$watch_version"
    xcrun simctl list runtimes
  fi
fi

(
  cd "${ROOT_DIR}/apps/ios"
  run_ios_fastlane ios screenshots
)
