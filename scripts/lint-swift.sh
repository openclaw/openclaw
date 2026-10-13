#!/bin/bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

scope="${1:-all}"
if [[ "$scope" != "all" && "$scope" != "ios" && "$scope" != "macos" ]]; then
  echo "usage: $0 [ios|macos]" >&2
  exit 2
fi

./scripts/check-swift-tools.sh swiftlint

if [[ "$scope" != "ios" ]]; then
  node "$repo_root/scripts/run-swiftlint.mts" --strict --config config/swiftlint.yml
  (
    cd apps/swabble
    node "$repo_root/scripts/run-swiftlint.mts" --strict --config .swiftlint.yml
  )
fi

if [[ "$scope" == "macos" ]]; then
  exit 0
fi

(
  cd apps/ios
  node "$repo_root/scripts/run-swiftlint.mts" --strict --config .swiftlint.yml
)
