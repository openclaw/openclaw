#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-release-upload.sh --version 2026.6.11 [--build-number 7]

Generates App Store screenshots, updates release metadata, archives, and uploads
an App Store distribution build to App Store Connect. This does not submit the
build for App Review.
EOF
}

BUILD_NUMBER=""
RELEASE_VERSION=""
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/ios-fastlane.sh"

require_option_value() {
  local option="$1"
  local value="${2-}"

  if [[ -z "${value}" || "${value}" == --* ]]; then
    echo "Missing value for ${option}." >&2
    usage >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --build-number)
      require_option_value "$1" "${2-}"
      BUILD_NUMBER="${2:-}"
      shift 2
      ;;
    --version)
      require_option_value "$1" "${2-}"
      RELEASE_VERSION="${2:-}"
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

if [[ -z "${RELEASE_VERSION}" ]]; then
  echo "Missing required --version." >&2
  usage >&2
  exit 1
fi

FASTLANE_ARGS=(ios release_upload "release_version:${RELEASE_VERSION}")
if [[ -n "${BUILD_NUMBER}" ]]; then
  FASTLANE_ARGS+=("build_number:${BUILD_NUMBER}")
fi

(
  cd "${ROOT_DIR}/apps/ios"
  # App Store Connect screenshot reservations can fail with 500s under parallel deliver uploads.
  DELIVER_NUMBER_OF_THREADS=1 FL_MAX_NUMBER_OF_THREADS=1 OPENCLAW_IOS_RELEASE_WRAPPER=1 run_ios_fastlane "${FASTLANE_ARGS[@]}"
)
