#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/apps/ios"

APP_NAME="${IOS_APP_NAME:-OpenClaw}"
CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
DERIVED_DATA_DIR="${IOS_DERIVED_DATA_DIR:-${IOS_DIR}/build/DerivedData}"
IOS_DESTINATION="${IOS_DEST:-platform=iOS Simulator,name=iPhone 17}"
SIMULATOR_TARGET="${IOS_SIM:-iPhone 17}"

XCODEBUILD_BIN="${IOS_RUN_XCODEBUILD_BIN:-xcodebuild}"
XCODEGEN_BIN="${IOS_RUN_XCODEGEN_BIN:-xcodegen}"
SIMCTL_BIN="${IOS_RUN_SIMCTL_BIN:-xcrun simctl}"
PLIST_BUDDY_BIN="${IOS_RUN_PLIST_BUDDY_BIN:-/usr/libexec/PlistBuddy}"

run_simctl() {
  # shellcheck disable=SC2086
  ${SIMCTL_BIN} "$@"
}

"${ROOT_DIR}/scripts/ios-configure-signing.sh"
"${ROOT_DIR}/scripts/ios-write-version-xcconfig.sh"

cd "${IOS_DIR}"
"${XCODEGEN_BIN}" generate
"${XCODEBUILD_BIN}" \
  -project OpenClaw.xcodeproj \
  -scheme OpenClaw \
  -destination "${IOS_DESTINATION}" \
  -configuration "${CONFIGURATION}" \
  -derivedDataPath "${DERIVED_DATA_DIR}" \
  build

app_path="${DERIVED_DATA_DIR}/Build/Products/${CONFIGURATION}-iphonesimulator/${APP_NAME}.app"
if [[ ! -d "${app_path}" ]]; then
  echo "ERROR: Built app not found at ${app_path}" >&2
  exit 1
fi

bundle_id="$("${PLIST_BUDDY_BIN}" -c 'Print :CFBundleIdentifier' "${app_path}/Info.plist" 2>/dev/null || true)"
if [[ -z "${bundle_id}" ]]; then
  echo "ERROR: Built app is missing CFBundleIdentifier: ${app_path}/Info.plist" >&2
  exit 1
fi

boot_output=""
if ! boot_output="$(run_simctl boot "${SIMULATOR_TARGET}" 2>&1)"; then
  if [[ "${boot_output}" != *"Unable to boot device in current state: Booted"* ]]; then
    printf '%s\n' "${boot_output}" >&2
    exit 1
  fi
fi

run_simctl install "${SIMULATOR_TARGET}" "${app_path}"
run_simctl launch "${SIMULATOR_TARGET}" "${bundle_id}"
