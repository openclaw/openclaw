#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-facetime-native-checks.XXXXXX")"

cleanup() {
  /usr/bin/trash "$build_dir"
}
trap cleanup EXIT

swiftc \
  "$repo_root/native/Sources/FaceTimeAudioCapture/InputRouteReadiness.swift" \
  "$repo_root/native/Checks/InputRouteReadinessChecks.swift" \
  -o "$build_dir/input-route-readiness-checks"

"$build_dir/input-route-readiness-checks"

swiftc \
  "$repo_root/native/Sources/FaceTimeAudioCapture/OutputRouteReadiness.swift" \
  "$repo_root/native/Checks/OutputRouteReadinessChecks.swift" \
  -o "$build_dir/output-route-readiness-checks"

"$build_dir/output-route-readiness-checks"
