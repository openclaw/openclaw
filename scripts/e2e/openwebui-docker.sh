#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"

IMAGE_NAME="openclaw-openwebui-e2e"
OPENWEBUI_IMAGE="${OPENWEBUI_IMAGE:-ghcr.io/open-webui/open-webui:v0.8.10}"
PROFILE_FILE="${OPENCLAW_PROFILE_FILE:-$HOME/.profile}"
MODEL="${OPENCLAW_OPENWEBUI_MODEL:-openai/gpt-5.4}"
PROMPT_NONCE="OPENWEBUI_DOCKER_E2E_$(date +%s)_$$"
PROMPT="${OPENCLAW_OPENWEBUI_PROMPT:-Reply with exactly this token and nothing else: ${PROMPT_NONCE}}"
PORT="${OPENCLAW_OPENWEBUI_GATEWAY_PORT:-18789}"
WEBUI_PORT="${OPENCLAW_OPENWEBUI_PORT:-8080}"
TOKEN="openwebui-e2e-$(date +%s)-$$"
ADMIN_EMAIL="${OPENCLAW_OPENWEBUI_ADMIN_EMAIL:-openwebui-e2e@example.com}"
ADMIN_PASSWORD="${OPENCLAW_OPENWEBUI_ADMIN_PASSWORD:-OpenWebUI-E2E-Password-$(date +%s)-$$}"
NET_NAME="openclaw-openwebui-e2e-$$"
GW_NAME="openclaw-openwebui-gateway-$$"
OW_NAME="openclaw-openwebui-$$"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/appuser/.profile:ro)
fi

AUTH_DIRS=()
if [[ -n "${OPENCLAW_DOCKER_AUTH_DIRS:-}" ]]; then
  while IFS= read -r auth_dir; do
    [[ -n "$auth_dir" ]] || continue
    AUTH_DIRS+=("$auth_dir")
  done < <(openclaw_live_collect_auth_dirs)
fi
AUTH_DIRS_CSV="$(openclaw_live_join_csv "${AUTH_DIRS[@]}")"

EXTERNAL_AUTH_MOUNTS=()
for auth_dir in "${AUTH_DIRS[@]}"; do
  host_path="$HOME/$auth_dir"
  if [[ -d "$host_path" ]]; then
    EXTERNAL_AUTH_MOUNTS+=(-v "$host_path":/host-auth/"$auth_dir":ro)
  fi
done

cleanup() {
  docker rm -f "$OW_NAME" >/dev/null 2>&1 || true
  docker rm -f "$GW_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Pulling Open WebUI image: $OPENWEBUI_IMAGE"
docker pull "$OPENWEBUI_IMAGE" >/dev/null

echo "Creating Docker network..."
docker network create "$NET_NAME" >/dev/null

echo "Starting gateway container..."
docker run -d \
  --name "$GW_NAME" \
  --network "$NET_NAME" \
  -e "OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED=$AUTH_DIRS_CSV" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_OPENWEBUI_MODEL=$MODEL" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  "${EXTERNAL_AUTH_MOUNTS[@]}" \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    [ -f "$HOME/.profile" ] && source "$HOME/.profile" || true
    IFS="," read -r -a auth_dirs <<<"${OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED:-}"
    for auth_dir in "${auth_dirs[@]}"; do
      [ -n "$auth_dir" ] || continue
      if [ -d "/host-auth/$auth_dir" ]; then
        mkdir -p "$HOME/$auth_dir"
        cp -R "/host-auth/$auth_dir/." "$HOME/$auth_dir"
        chmod -R u+rwX "$HOME/$auth_dir" || true
      fi
    done

    entry=dist/index.mjs
    [ -f "$entry" ] || entry=dist/index.js

    node "$entry" config set gateway.controlUi.enabled false >/dev/null
    node "$entry" config set gateway.mode local >/dev/null
    node "$entry" config set gateway.bind lan >/dev/null
    node "$entry" config set gateway.auth.mode token >/dev/null
    node "$entry" config set gateway.auth.token "$OPENCLAW_GATEWAY_TOKEN" >/dev/null
    node "$entry" config set gateway.http.endpoints.chatCompletions.enabled true --strict-json >/dev/null
    node "$entry" config set agents.defaults.model.primary "$OPENCLAW_OPENWEBUI_MODEL" >/dev/null

    exec node "$entry" gateway --port '"$PORT"' --bind lan --allow-unconfigured > /tmp/openwebui-gateway.log 2>&1
  '

echo "Waiting for gateway HTTP surface..."
gateway_ready=0
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$GW_NAME" 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  if docker exec "$GW_NAME" bash -lc "node --input-type=module -e '
    const res = await fetch(\"http://127.0.0.1:$PORT/v1/models\", {
      headers: { authorization: \"Bearer $TOKEN\" },
    }).catch(() => null);
    process.exit(res?.status === 200 ? 0 : 1);
  ' >/dev/null 2>&1"; then
    gateway_ready=1
    break
  fi
  sleep 1
done

if [ "$gateway_ready" -ne 1 ]; then
  echo "Gateway failed to start"
  docker logs "$GW_NAME" 2>&1 | tail -n 200 || true
  exit 1
fi

echo "Starting Open WebUI container..."
docker run -d \
  --name "$OW_NAME" \
  --network "$NET_NAME" \
  -e ENV=prod \
  -e WEBUI_NAME="OpenClaw E2E" \
  -e WEBUI_SECRET_KEY="openclaw-openwebui-e2e-secret" \
  -e OFFLINE_MODE=True \
  -e ENABLE_VERSION_UPDATE_CHECK=False \
  -e ENABLE_PERSISTENT_CONFIG=False \
  -e ENABLE_OLLAMA_API=False \
  -e ENABLE_OPENAI_API=True \
  -e OPENAI_API_BASE_URLS="http://$GW_NAME:$PORT/v1" \
  -e OPENAI_API_KEY="$TOKEN" \
  -e OPENAI_API_KEYS="$TOKEN" \
  -e RAG_EMBEDDING_MODEL_AUTO_UPDATE=False \
  -e RAG_RERANKING_MODEL_AUTO_UPDATE=False \
  -e WEBUI_ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e WEBUI_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e WEBUI_ADMIN_NAME="OpenClaw E2E" \
  -e ENABLE_SIGNUP=False \
  -e DEFAULT_MODELS="openclaw/default" \
  "$OPENWEBUI_IMAGE" >/dev/null

echo "Waiting for Open WebUI..."
ow_ready=0
for _ in $(seq 1 90); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$OW_NAME" 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  if docker exec "$GW_NAME" bash -lc "node --input-type=module -e '
    const res = await fetch(\"http://$OW_NAME:$WEBUI_PORT/\").catch(() => null);
    process.exit(res && res.status < 500 ? 0 : 1);
  ' >/dev/null 2>&1"; then
    ow_ready=1
    break
  fi
  sleep 1
done

if [ "$ow_ready" -ne 1 ]; then
  echo "Open WebUI failed to start"
  docker logs "$OW_NAME" 2>&1 | tail -n 200 || true
  exit 1
fi

echo "Running Open WebUI -> OpenClaw smoke..."
docker exec \
  -e "OPENWEBUI_BASE_URL=http://$OW_NAME:$WEBUI_PORT" \
  -e "OPENWEBUI_ADMIN_EMAIL=$ADMIN_EMAIL" \
  -e "OPENWEBUI_ADMIN_PASSWORD=$ADMIN_PASSWORD" \
  -e "OPENWEBUI_EXPECTED_NONCE=$PROMPT_NONCE" \
  -e "OPENWEBUI_PROMPT=$PROMPT" \
  "$GW_NAME" \
  node /app/scripts/e2e/openwebui-probe.mjs

echo "Open WebUI container logs:"
docker logs "$OW_NAME" 2>&1 | tail -n 80 || true

echo "OK"
