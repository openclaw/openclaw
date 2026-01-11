#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${CLAWDBOT_INSTALL_SMOKE_IMAGE:-clawdbot-install-smoke:local}"
INSTALL_URL="${CLAWDBOT_INSTALL_URL:-https://clawd.bot/install.sh}"

echo "==> Build image: $IMAGE_NAME"
docker build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/install-sh-smoke/Dockerfile" \
  "$ROOT_DIR/scripts/docker/install-sh-smoke"

echo "==> Run installer smoke test: $INSTALL_URL"
docker run --rm -t \
  -e CLAWDBOT_INSTALL_URL="$INSTALL_URL" \
  "$IMAGE_NAME"
