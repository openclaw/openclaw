#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw-mcp-channels-e2e}"
PORT="18789"
TOKEN="mcp-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-mcp-e2e-$$"
CLIENT_LOG="$(mktemp -t openclaw-mcp-client-log.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Running in-container gateway + MCP smoke..."
set +e
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e "OPENCLAW_STATE_DIR=/tmp/openclaw-state" \
  -e "OPENCLAW_CONFIG_PATH=/tmp/openclaw-state/openclaw.json" \
  -e "GW_URL=ws://127.0.0.1:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    entry=dist/index.mjs
    [ -f \"\$entry\" ] || entry=dist/index.js
    node --import tsx scripts/e2e/mcp-channels-seed.ts >/tmp/mcp-channels-seed.log
    node \"\$entry\" gateway --port $PORT --bind loopback --allow-unconfigured >/tmp/mcp-channels-gateway.log 2>&1 &
    gateway_pid=\$!
    cleanup_inner() {
      kill \"\$gateway_pid\" >/dev/null 2>&1 || true
      wait \"\$gateway_pid\" >/dev/null 2>&1 || true
    }
    trap cleanup_inner EXIT
    for _ in \$(seq 1 80); do
      if node --input-type=module -e '
        import net from \"node:net\";
        const socket = net.createConnection({ host: \"127.0.0.1\", port: $PORT });
        const timeout = setTimeout(() => {
          socket.destroy();
          process.exit(1);
        }, 400);
        socket.on(\"connect\", () => {
          clearTimeout(timeout);
          socket.end();
          process.exit(0);
        });
        socket.on(\"error\", () => {
          clearTimeout(timeout);
          process.exit(1);
        });
      ' >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    node --import tsx scripts/e2e/mcp-channels-docker-client.ts
    tail -n 80 /tmp/mcp-channels-gateway.log
  " | tee "$CLIENT_LOG"
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker MCP smoke failed"
  exit "$status"
fi

echo "OK"
