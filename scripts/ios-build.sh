#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/apps/ios"
SCHEME="${IOS_SCHEME:-OpenClaw}"
CONFIGURATION="${IOS_CONFIGURATION:-Debug}"

cd "${ROOT_DIR}"

./scripts/ios-configure-signing.sh
./scripts/ios-write-version-xcconfig.sh
simulator_env="$(./scripts/resolve-ios-simulator.sh --shell)"
eval "${simulator_env}"

echo "Using iOS simulator: ${IOS_SIM_NAME} (${IOS_SIM_UDID})"
echo "Using destination: ${IOS_DEST}"

cd "${IOS_DIR}"
../../scripts/with-xcode-developer-dir.sh xcodegen generate
../../scripts/with-xcode-developer-dir.sh xcodebuild \
  -project OpenClaw.xcodeproj \
  -scheme "${SCHEME}" \
  -destination "${IOS_DEST}" \
  -configuration "${CONFIGURATION}" \
  build
