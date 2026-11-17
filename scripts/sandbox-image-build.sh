#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${OPENCLAW_SANDBOX_IMAGE:-openclaw-sandbox:trixie-slim}"

export DOCKER_BUILDKIT=1
exec docker build --progress=plain -t "$IMAGE_NAME" \
  -f "$SCRIPT_DIR/docker/sandbox/Dockerfile" "$SCRIPT_DIR/docker/sandbox"
