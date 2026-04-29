#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-config-reload-e2e" OPENCLAW_CONFIG_RELOAD_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_CONFIG_RELOAD_E2E_SKIP_BUILD:-0}"
PORT="18789"
TOKEN="reload-e2e-token"
CONTAINER_NAME="openclaw-config-reload-e2e-$$"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" config-reload "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"
docker_e2e_harness_mount_args
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 config-reload empty)"

echo "Starting gateway container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e GATEWAY_AUTH_TOKEN_REF="$TOKEN" \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e OPENCLAW_SKIP_GMAIL_WATCHER=1 \
  -e OPENCLAW_SKIP_CRON=1 \
  -e OPENCLAW_SKIP_CANVAS_HOST=1 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 \"\${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}\"
openclaw_e2e_write_state_env
entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
cat > \"\$OPENCLAW_CONFIG_PATH\" <<'JSON'
{
  \"gateway\": {
    \"port\": $PORT,
    \"auth\": {
      \"mode\": \"token\",
      \"token\": {
        \"source\": \"env\",
        \"provider\": \"default\",
        \"id\": \"GATEWAY_AUTH_TOKEN_REF\"
      }
    },
    \"channelHealthCheckMinutes\": 1,
    \"controlUi\": {
      \"enabled\": false
    },
    \"reload\": {
      \"mode\": \"hybrid\",
      \"debounceMs\": 0
    }
  }
}
JSON
openclaw_e2e_exec_gateway \"\$entry\" $PORT loopback /tmp/config-reload-e2e.log" >/dev/null

echo "Waiting for gateway..."
ready=0
for _ in $(seq 1 180); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  if docker exec "$CONTAINER_NAME" bash -lc "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_tcp 127.0.0.1 $PORT" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "Gateway failed to start"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -n 120 || true
  docker exec "$CONTAINER_NAME" bash -lc "tail -n 120 /tmp/config-reload-e2e.log" || true
  exit 1
fi

echo "Checking initial RPC status..."
docker exec "$CONTAINER_NAME" bash -lc "
source /tmp/openclaw-test-state-env
source scripts/lib/openclaw-e2e-instance.sh
entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
node \"\$entry\" gateway status --url ws://127.0.0.1:$PORT --token '$TOKEN' --require-rpc --timeout 30000 >/tmp/config-reload-status-before.log
"

echo "Mutating hot-reload gateway metadata..."
docker exec "$CONTAINER_NAME" bash -lc "source /tmp/openclaw-test-state-env
node --input-type=module - <<'NODE'
import fs from 'node:fs';

const configPath = process.env.OPENCLAW_CONFIG_PATH;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.gateway.channelHealthCheckMinutes = 2;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
NODE"

sleep 2

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" != "true" ]; then
  echo "Gateway container exited after config metadata write"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -n 120 || true
  exit 1
fi

echo "Checking post-write RPC status..."
docker exec "$CONTAINER_NAME" bash -lc "
source /tmp/openclaw-test-state-env
source scripts/lib/openclaw-e2e-instance.sh
entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
node \"\$entry\" gateway status --url ws://127.0.0.1:$PORT --token '$TOKEN' --require-rpc --timeout 30000 >/tmp/config-reload-status-after.log
"

echo "Checking reload log..."
docker exec "$CONTAINER_NAME" bash -lc "node --input-type=module - <<'NODE'
import fs from 'node:fs';

const log = fs.readFileSync('/tmp/config-reload-e2e.log', 'utf8');
const reloadLines = log
  .split('\n')
  .filter((line) => line.includes('config change detected; evaluating reload'));
const restartLines = log
  .split('\n')
  .filter((line) => line.includes('config change requires gateway restart'));
if (restartLines.length > 0) {
  console.error(log.split('\n').slice(-160).join('\n'));
  throw new Error('unexpected restart-required reload line found');
}
for (const line of reloadLines) {
  for (const needle of ['gateway.auth.token', 'plugins.entries.firecrawl.config.webFetch']) {
    if (line.includes(needle)) {
      console.error(log.split('\n').slice(-160).join('\n'));
      throw new Error('runtime-only path appeared in reload diff: ' + needle);
    }
  }
}
if (reloadLines.length === 0) {
  console.error(log.split('\n').slice(-160).join('\n'));
  throw new Error('expected config reload detection log after metadata write');
}
console.log('ok');
NODE"

echo "Config reload Docker E2E passed."
