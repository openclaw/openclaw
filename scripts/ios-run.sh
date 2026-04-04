#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/apps/ios"
APP_BUNDLE_ID="${IOS_APP_BUNDLE_ID:-ai.vericlaw.ios}"

cd "${ROOT_DIR}"

./scripts/ios-build.sh
simulator_env="$(./scripts/resolve-ios-simulator.sh --shell)"
eval "${simulator_env}"

cd "${IOS_DIR}"
../../scripts/with-xcode-developer-dir.sh xcrun simctl boot "${IOS_SIM_UDID}" >/dev/null 2>&1 || true
../../scripts/with-xcode-developer-dir.sh xcrun simctl bootstatus "${IOS_SIM_UDID}" -b
../../scripts/with-xcode-developer-dir.sh xcrun simctl launch "${IOS_SIM_UDID}" "${APP_BUNDLE_ID}"
