#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-beta-archive.sh [--build-number 7]

Archives and exports a beta-release IPA locally without uploading.
EOF
}

BUILD_NUMBER="${IOS_BETA_BUILD_NUMBER:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
  IOS_BETA_BUILD_NUMBER="${BUILD_NUMBER}" fastlane ios beta_archive
)
