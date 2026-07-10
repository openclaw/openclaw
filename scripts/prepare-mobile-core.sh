#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec "${ROOT_DIR}/apps/android/gradlew" \
  -p "${ROOT_DIR}/apps/android" \
  :mobile-core:assembleOpenClawMobileCoreReleaseXCFramework
