#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"
IMAGE_NAME="${OPENCLAW_QR_SMOKE_IMAGE:-openclaw-qr-smoke}"

echo "Building Docker image..."
run_logged qr-import-build docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile.qr-import" "$ROOT_DIR"

echo "Running qrcode-terminal import smoke..."
run_logged qr-import-run docker run --rm -t "$IMAGE_NAME" node -e "import('qrcode-terminal').then((m)=>m.default.generate('qr-smoke',{small:true}))"
