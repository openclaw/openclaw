#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-beta-release.sh --version 2026.3.9-beta.1 [--build-number 7]

Archives and uploads a beta-release IPA to TestFlight locally.
EOF
}

VERSION="${IOS_BETA_VERSION:-}"
BUILD_NUMBER="${IOS_BETA_BUILD_NUMBER:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
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

if [[ -z "${VERSION}" ]]; then
  echo "Missing required --version (or IOS_BETA_VERSION)." >&2
  usage
  exit 1
fi

(
  cd "${ROOT_DIR}/apps/ios"
  IOS_BETA_VERSION="${VERSION}" \
  IOS_BETA_BUILD_NUMBER="${BUILD_NUMBER}" \
  fastlane ios beta
)
