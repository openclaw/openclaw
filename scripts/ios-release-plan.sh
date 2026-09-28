#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-release-plan.sh [--json] [--version 2026.7.2] [--revision 1] [--build-number 3]

Reads App Store Connect state and prints the deterministic iOS release plan.
This command does not mutate App Store Connect or repository files.
EOF
}

BUILD_NUMBER=""
APP_STORE_REVISION=""
RELEASE_VERSION=""
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/ios-fastlane.sh"

parse_ios_release_args plan "$@"

PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-ios-release-plan.XXXXXX")"
trap 'rm -f "${PLAN_FILE}"' EXIT
FASTLANE_ARGS=(ios release_plan "output_path:${PLAN_FILE}")
[[ -n "${RELEASE_VERSION}" ]] && FASTLANE_ARGS+=("release_version:${RELEASE_VERSION}")
[[ -n "${APP_STORE_REVISION}" ]] && FASTLANE_ARGS+=("app_store_revision:${APP_STORE_REVISION}")
[[ -n "${BUILD_NUMBER}" ]] && FASTLANE_ARGS+=("build_number:${BUILD_NUMBER}")

if ! (
  cd "${ROOT_DIR}/apps/ios"
  run_ios_fastlane "${FASTLANE_ARGS[@]}" 1>&2
); then
  echo "Failed to resolve the iOS release plan." >&2
  exit 1
fi
cat "${PLAN_FILE}"
