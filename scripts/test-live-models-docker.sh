#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${EASYHUB_IMAGE:-${EASYHUB_IMAGE:-EasyHub:local}}"
CONFIG_DIR="${EASYHUB_CONFIG_DIR:-${EASYHUB_CONFIG_DIR:-$HOME/.EasyHub}}"
WORKSPACE_DIR="${EASYHUB_WORKSPACE_DIR:-${EASYHUB_WORKSPACE_DIR:-$HOME/.easyhub/workspace}}"
PROFILE_FILE="${EASYHUB_PROFILE_FILE:-${EASYHUB_PROFILE_FILE:-$HOME/.profile}}"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

echo "==> Build image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run live model tests (profile keys)"
docker run --rm -t \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e EASYHUB_LIVE_TEST=1 \
  -e EASYHUB_LIVE_MODELS="${EASYHUB_LIVE_MODELS:-${EASYHUB_LIVE_MODELS:-all}}" \
  -e EASYHUB_LIVE_PROVIDERS="${EASYHUB_LIVE_PROVIDERS:-${EASYHUB_LIVE_PROVIDERS:-}}" \
  -e EASYHUB_LIVE_MODEL_TIMEOUT_MS="${EASYHUB_LIVE_MODEL_TIMEOUT_MS:-${EASYHUB_LIVE_MODEL_TIMEOUT_MS:-}}" \
  -e EASYHUB_LIVE_REQUIRE_PROFILE_KEYS="${EASYHUB_LIVE_REQUIRE_PROFILE_KEYS:-${EASYHUB_LIVE_REQUIRE_PROFILE_KEYS:-}}" \
  -v "$CONFIG_DIR":/home/node/.EasyHub \
  -v "$WORKSPACE_DIR":/home/node/.easyhub/workspace \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  -lc "set -euo pipefail; [ -f \"$HOME/.profile\" ] && source \"$HOME/.profile\" || true; cd /app && pnpm test:live"
