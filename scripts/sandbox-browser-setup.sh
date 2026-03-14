#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="openclaw-sandbox-browser:trixie-slim"

docker build -t "${IMAGE_NAME}" -f Dockerfile.sandbox-browser .
echo "Built ${IMAGE_NAME}"
