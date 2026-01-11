#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${CLAWDBOT_INSTALL_E2E_IMAGE:-clawdbot-install-e2e:local}"
INSTALL_URL="${CLAWDBOT_INSTALL_URL:-https://clawd.bot/install.sh}"

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
CLAWDBOT_E2E_MODELS="${CLAWDBOT_E2E_MODELS:-}"

echo "==> Build image: $IMAGE_NAME"
docker build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/install-sh-e2e/Dockerfile" \
  "$ROOT_DIR/scripts/docker/install-sh-e2e"

echo "==> Run E2E installer test"
docker run --rm -t \
  -e CLAWDBOT_INSTALL_URL="$INSTALL_URL" \
  -e CLAWDBOT_E2E_MODELS="$CLAWDBOT_E2E_MODELS" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  "$IMAGE_NAME"
