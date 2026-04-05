#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${MULLUSI_IMAGE:-mullusi:local}"
LIVE_IMAGE_NAME="${MULLUSI_LIVE_IMAGE:-${IMAGE_NAME}-live}"

if [[ "${MULLUSI_SKIP_DOCKER_BUILD:-}" == "1" ]]; then
  echo "==> Reuse live-test image: $LIVE_IMAGE_NAME"
  exit 0
fi

echo "==> Build live-test image: $LIVE_IMAGE_NAME (target=build)"
docker build --target build -t "$LIVE_IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
