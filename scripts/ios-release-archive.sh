#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-release-archive.sh --version 2026.7.2 --revision 1 [--build-number 3]

Archives and exports an App Store distribution IPA locally without uploading.
EOF
}

BUILD_NUMBER=""
APP_STORE_REVISION=""
RELEASE_VERSION=""
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/ios-fastlane.sh"

parse_ios_release_args archive "$@"

if [[ -z "${RELEASE_VERSION}" ]]; then
  echo "Missing required --version." >&2
  usage >&2
  exit 1
fi

if [[ -z "${APP_STORE_REVISION}" ]]; then
  echo "Missing required --revision." >&2
  usage >&2
  exit 1
fi

FASTLANE_ARGS=(ios app_store_archive "release_version:${RELEASE_VERSION}" "app_store_revision:${APP_STORE_REVISION}")
if [[ -n "${BUILD_NUMBER}" ]]; then
  FASTLANE_ARGS+=("build_number:${BUILD_NUMBER}")
fi

(
  cd "${ROOT_DIR}/apps/ios"
  run_ios_fastlane "${FASTLANE_ARGS[@]}"
)
