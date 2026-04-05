#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${MULLUSI_INSTALL_E2E_IMAGE:-mullusi-install-e2e:local}"
INSTALL_URL="${MULLUSI_INSTALL_URL:-https://mullusi.bot/install.sh}"

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_TOKEN="${ANTHROPIC_API_TOKEN:-}"
MULLUSI_E2E_MODELS="${MULLUSI_E2E_MODELS:-}"

echo "==> Build image: $IMAGE_NAME"
docker build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/install-sh-e2e/Dockerfile" \
  "$ROOT_DIR/scripts/docker"

echo "==> Run E2E installer test"
docker run --rm \
  -e MULLUSI_INSTALL_URL="$INSTALL_URL" \
  -e MULLUSI_INSTALL_TAG="${MULLUSI_INSTALL_TAG:-latest}" \
  -e MULLUSI_E2E_MODELS="$MULLUSI_E2E_MODELS" \
  -e MULLUSI_INSTALL_E2E_PREVIOUS="${MULLUSI_INSTALL_E2E_PREVIOUS:-}" \
  -e MULLUSI_INSTALL_E2E_SKIP_PREVIOUS="${MULLUSI_INSTALL_E2E_SKIP_PREVIOUS:-0}" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e ANTHROPIC_API_TOKEN="$ANTHROPIC_API_TOKEN" \
  "$IMAGE_NAME"
