#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd python3

SAFE_ROOT_DEFAULT="/Volumes/ Crucial Deez X9 Pro /openclaw_safe_live"
SAFE_ROOT="${OPENCLAW_SAFE_ROOT:-$SAFE_ROOT_DEFAULT}"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$SAFE_ROOT/config}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$SAFE_ROOT/workspace}"
OPENCLAW_LOG_DIR="${OPENCLAW_LOG_DIR:-$SAFE_ROOT/logs}"
OPENCLAW_CACHE_DIR="${OPENCLAW_CACHE_DIR:-$SAFE_ROOT/cache}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-openclaw:local-safe}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-127.0.0.1:18889}"
OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-127.0.0.1:18790}"
OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
ENV_FILE="${OPENCLAW_SAFE_ENV_FILE:-$ROOT_DIR/.env.safe}"

mkdir -p "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_LOG_DIR" "$OPENCLAW_CACHE_DIR"

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  OPENCLAW_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
fi
export OPENCLAW_GATEWAY_TOKEN

# Preserve an existing OpenAI API key from the env file unless explicitly overridden.
if [[ -z "${OPENAI_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  OPENAI_API_KEY="$(awk -F= '/^OPENAI_API_KEY=/{print substr($0, index($0, "=")+1)}' "$ENV_FILE" | tail -n1)"
fi

cat >"$ENV_FILE" <<EOF
OPENCLAW_CONFIG_DIR=$OPENCLAW_CONFIG_DIR
OPENCLAW_WORKSPACE_DIR=$OPENCLAW_WORKSPACE_DIR
OPENCLAW_IMAGE=$OPENCLAW_IMAGE
OPENCLAW_GATEWAY_PORT=$OPENCLAW_GATEWAY_PORT
OPENCLAW_BRIDGE_PORT=$OPENCLAW_BRIDGE_PORT
OPENCLAW_GATEWAY_BIND=$OPENCLAW_GATEWAY_BIND
OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
OPENAI_API_KEY=${OPENAI_API_KEY:-}
EOF

echo "==> Building image: $OPENCLAW_IMAGE"
docker build -t "$OPENCLAW_IMAGE" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Running non-interactive local onboard (safe baseline)"
docker compose --env-file "$ENV_FILE" run --rm openclaw-cli onboard \
  --non-interactive \
  --accept-risk \
  --mode local \
  --auth-choice skip \
  --gateway-bind lan \
  --gateway-auth token \
  --gateway-token "$OPENCLAW_GATEWAY_TOKEN" \
  --tailscale off \
  --skip-channels \
  --skip-skills \
  --skip-ui \
  --skip-health \
  --no-install-daemon

echo "==> Applying runtime safety policy"
docker compose --env-file "$ENV_FILE" run --rm openclaw-cli config set tools.allow '["group:web","group:fs","group:memory","sessions_list","sessions_history","sessions_send","session_status","image"]' --json
docker compose --env-file "$ENV_FILE" run --rm openclaw-cli config set tools.deny '["group:runtime","browser","canvas","nodes","cron","gateway","subagents","sessions_spawn"]' --json
docker compose --env-file "$ENV_FILE" run --rm openclaw-cli config set tools.profile full
docker compose --env-file "$ENV_FILE" run --rm openclaw-cli config set gateway.bind lan
docker compose --env-file "$ENV_FILE" run --rm openclaw-cli config set gateway.auth.mode token
docker compose --env-file "$ENV_FILE" run --rm openclaw-cli config set gateway.controlUi.enabled true
docker compose --env-file "$ENV_FILE" run --rm openclaw-cli config set gateway.controlUi.basePath /

echo "==> Starting gateway"
docker compose --env-file "$ENV_FILE" up -d openclaw-gateway

echo ""
echo "Safe OpenClaw is running."
echo "Control UI: http://127.0.0.1:${OPENCLAW_GATEWAY_PORT##*:}"
echo "Gateway token: ${OPENCLAW_GATEWAY_TOKEN}"
echo "Config dir: ${OPENCLAW_CONFIG_DIR}"
echo "Workspace dir: ${OPENCLAW_WORKSPACE_DIR}"
echo "Env file: ${ENV_FILE}"
echo ""
echo "Health check:"
echo "docker compose --env-file \"$ENV_FILE\" exec openclaw-gateway node dist/index.js health"
