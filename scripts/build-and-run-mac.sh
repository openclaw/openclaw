#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}/apps/macos"

BUILD_PATH=".build-local"
PRODUCT="OpenClaw"
BIN="$BUILD_PATH/debug/$PRODUCT"
MAC_SWIFT="${ROOT_DIR}/scripts/macos-swift.sh"

printf "\n▶️  Building $PRODUCT (debug, build path: $BUILD_PATH)\n"
"$MAC_SWIFT" build -c debug --product "$PRODUCT" --build-path "$BUILD_PATH"

printf "\n⏹  Stopping existing $PRODUCT...\n"
killall -q "$PRODUCT" 2>/dev/null || true

printf "\n🚀 Launching $BIN ...\n"
nohup "$BIN" >/tmp/openclaw.log 2>&1 &
PID=$!
printf "Started $PRODUCT (PID $PID). Logs: /tmp/openclaw.log\n"
