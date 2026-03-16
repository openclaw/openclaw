#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${OPENCLAW_IMAGE:-${CLAWDBOT_IMAGE:-openclaw:local}}"
LIVE_IMAGE_NAME="${OPENCLAW_LIVE_IMAGE:-${CLAWDBOT_LIVE_IMAGE:-${IMAGE_NAME}-live}}"
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-${CLAWDBOT_CONFIG_DIR:-$HOME/.openclaw}}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${CLAWDBOT_WORKSPACE_DIR:-$HOME/.openclaw/workspace}}"
PROFILE_FILE="${OPENCLAW_PROFILE_FILE:-${CLAWDBOT_PROFILE_FILE:-$HOME/.profile}}"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && source "$HOME/.profile" || true
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
tar -C /src \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=ui/dist \
  --exclude=ui/node_modules \
  -cf - . | tar -C "$tmp_dir" -xf -
ln -s /app/node_modules "$tmp_dir/node_modules"
ln -s /app/dist "$tmp_dir/dist"
cd "$tmp_dir"
pnpm test:live
EOF

echo "==> Build live-test image: $LIVE_IMAGE_NAME (target=build)"
docker build --target build -t "$LIVE_IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run live model tests (profile keys)"
docker run --rm -t \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e OPENCLAW_LIVE_TEST=1 \
  -e OPENCLAW_LIVE_MODELS="${OPENCLAW_LIVE_MODELS:-${CLAWDBOT_LIVE_MODELS:-modern}}" \
  -e OPENCLAW_LIVE_PROVIDERS="${OPENCLAW_LIVE_PROVIDERS:-${CLAWDBOT_LIVE_PROVIDERS:-}}" \
  -e OPENCLAW_LIVE_MAX_MODELS="${OPENCLAW_LIVE_MAX_MODELS:-${CLAWDBOT_LIVE_MAX_MODELS:-48}}" \
  -e OPENCLAW_LIVE_MODEL_TIMEOUT_MS="${OPENCLAW_LIVE_MODEL_TIMEOUT_MS:-${CLAWDBOT_LIVE_MODEL_TIMEOUT_MS:-}}" \
  -e OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS="${OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS:-${CLAWDBOT_LIVE_REQUIRE_PROFILE_KEYS:-}}" \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.openclaw \
  -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace \
  "${PROFILE_MOUNT[@]}" \
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD"
