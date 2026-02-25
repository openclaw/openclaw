#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${ACTIVI_IMAGE:-${ACTIVI_IMAGE:-activi:local}}"
CONFIG_DIR="${ACTIVI_CONFIG_DIR:-${ACTIVI_CONFIG_DIR:-$HOME/.activi}}"
WORKSPACE_DIR="${ACTIVI_WORKSPACE_DIR:-${ACTIVI_WORKSPACE_DIR:-$HOME/.activi/workspace}}"
PROFILE_FILE="${ACTIVI_PROFILE_FILE:-${ACTIVI_PROFILE_FILE:-$HOME/.profile}}"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

echo "==> Build image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run gateway live model tests (profile keys)"
docker run --rm -t \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e ACTIVI_LIVE_TEST=1 \
  -e ACTIVI_LIVE_GATEWAY_MODELS="${ACTIVI_LIVE_GATEWAY_MODELS:-${ACTIVI_LIVE_GATEWAY_MODELS:-all}}" \
  -e ACTIVI_LIVE_GATEWAY_PROVIDERS="${ACTIVI_LIVE_GATEWAY_PROVIDERS:-${ACTIVI_LIVE_GATEWAY_PROVIDERS:-}}" \
  -e ACTIVI_LIVE_GATEWAY_MODEL_TIMEOUT_MS="${ACTIVI_LIVE_GATEWAY_MODEL_TIMEOUT_MS:-${ACTIVI_LIVE_GATEWAY_MODEL_TIMEOUT_MS:-}}" \
  -v "$CONFIG_DIR":/home/node/.activi \
  -v "$WORKSPACE_DIR":/home/node/.activi/workspace \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  -lc "set -euo pipefail; [ -f \"$HOME/.profile\" ] && source \"$HOME/.profile\" || true; cd /app && pnpm test:live"
