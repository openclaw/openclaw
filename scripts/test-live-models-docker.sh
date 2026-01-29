#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${DNA_IMAGE:-dna:local}"
CONFIG_DIR="${DNA_CONFIG_DIR:-$HOME/.dna}"
WORKSPACE_DIR="${DNA_WORKSPACE_DIR:-$HOME/clawd}"
PROFILE_FILE="${DNA_PROFILE_FILE:-$HOME/.profile}"

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
  -e DNA_LIVE_TEST=1 \
  -e DNA_LIVE_MODELS="${DNA_LIVE_MODELS:-all}" \
  -e DNA_LIVE_PROVIDERS="${DNA_LIVE_PROVIDERS:-}" \
  -e DNA_LIVE_MODEL_TIMEOUT_MS="${DNA_LIVE_MODEL_TIMEOUT_MS:-}" \
  -e DNA_LIVE_REQUIRE_PROFILE_KEYS="${DNA_LIVE_REQUIRE_PROFILE_KEYS:-}" \
  -v "$CONFIG_DIR":/home/node/.dna \
  -v "$WORKSPACE_DIR":/home/node/clawd \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  -lc "set -euo pipefail; [ -f \"$HOME/.profile\" ] && source \"$HOME/.profile\" || true; cd /app && pnpm test:live"
