#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${SMART_AGENT_NEO_IMAGE:-${NEOBOT_IMAGE:-smart-agent-neo:local}}"
CONFIG_DIR="${SMART_AGENT_NEO_CONFIG_DIR:-${NEOBOT_CONFIG_DIR:-$HOME/.smart-agent-neo}}"
WORKSPACE_DIR="${SMART_AGENT_NEO_WORKSPACE_DIR:-${NEOBOT_WORKSPACE_DIR:-$HOME/.smart-agent-neo/workspace}}"
PROFILE_FILE="${SMART_AGENT_NEO_PROFILE_FILE:-${NEOBOT_PROFILE_FILE:-$HOME/.profile}}"

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
  -e SMART_AGENT_NEO_LIVE_TEST=1 \
  -e SMART_AGENT_NEO_LIVE_MODELS="${SMART_AGENT_NEO_LIVE_MODELS:-${NEOBOT_LIVE_MODELS:-all}}" \
  -e SMART_AGENT_NEO_LIVE_PROVIDERS="${SMART_AGENT_NEO_LIVE_PROVIDERS:-${NEOBOT_LIVE_PROVIDERS:-}}" \
  -e SMART_AGENT_NEO_LIVE_MODEL_TIMEOUT_MS="${SMART_AGENT_NEO_LIVE_MODEL_TIMEOUT_MS:-${NEOBOT_LIVE_MODEL_TIMEOUT_MS:-}}" \
  -e SMART_AGENT_NEO_LIVE_REQUIRE_PROFILE_KEYS="${SMART_AGENT_NEO_LIVE_REQUIRE_PROFILE_KEYS:-${NEOBOT_LIVE_REQUIRE_PROFILE_KEYS:-}}" \
  -v "$CONFIG_DIR":/home/node/.smart-agent-neo \
  -v "$WORKSPACE_DIR":/home/node/.smart-agent-neo/workspace \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  -lc "set -euo pipefail; [ -f \"$HOME/.profile\" ] && source \"$HOME/.profile\" || true; cd /app && pnpm test:live"
