#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-release-upload.sh [--build-number 7]

Generates App Store screenshots, updates release metadata, archives, and uploads
an App Store distribution build to App Store Connect. This does not submit the
build for App Review.
EOF
}

BUILD_NUMBER="${IOS_RELEASE_BUILD_NUMBER:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/ios-fastlane.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --build-number)
      BUILD_NUMBER="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

(
  cd "${ROOT_DIR}/apps/ios"
  IOS_RELEASE_BUILD_NUMBER="${BUILD_NUMBER}" run_ios_fastlane ios release_upload
)
