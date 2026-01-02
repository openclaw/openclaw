#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
IMAGE_NAME="${CLAWDIS_IMAGE:-clawdis:local}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

mkdir -p "${CLAWDIS_CONFIG_DIR:-$HOME/.clawdis}"
mkdir -p "${CLAWDIS_WORKSPACE_DIR:-$HOME/clawd}"

export CLAWDIS_CONFIG_DIR="${CLAWDIS_CONFIG_DIR:-$HOME/.clawdis}"
export CLAWDIS_WORKSPACE_DIR="${CLAWDIS_WORKSPACE_DIR:-$HOME/clawd}"
export CLAWDIS_GATEWAY_PORT="${CLAWDIS_GATEWAY_PORT:-18789}"
export CLAWDIS_BRIDGE_PORT="${CLAWDIS_BRIDGE_PORT:-18790}"
export CLAWDIS_GATEWAY_BIND="${CLAWDIS_GATEWAY_BIND:-lan}"
export CLAWDIS_IMAGE="$IMAGE_NAME"

if [[ -z "${CLAWDIS_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    CLAWDIS_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    CLAWDIS_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
fi
export CLAWDIS_GATEWAY_TOKEN

ENV_FILE="$ROOT_DIR/.env"
upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"
  declare -A seen=()

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      local key="${line%%=*}"
      local replaced=false
      for k in "${keys[@]}"; do
        if [[ "$key" == "$k" ]]; then
          printf '%s=%s\n' "$k" "${!k}" >>"$tmp"
          seen["$k"]=1
          replaced=true
          break
        fi
      done
      if [[ "$replaced" == false ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  for k in "${keys[@]}"; do
    if [[ -z "${seen[$k]:-}" ]]; then
      printf '%s=%s\n' "$k" "${!k}" >>"$tmp"
    fi
  done

  mv "$tmp" "$file"
}

upsert_env "$ENV_FILE" \
  CLAWDIS_CONFIG_DIR \
  CLAWDIS_WORKSPACE_DIR \
  CLAWDIS_GATEWAY_PORT \
  CLAWDIS_BRIDGE_PORT \
  CLAWDIS_GATEWAY_BIND \
  CLAWDIS_GATEWAY_TOKEN \
  CLAWDIS_IMAGE

echo "==> Building Docker image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo ""
echo "==> Onboarding (interactive)"
echo "When prompted:"
echo "  - Gateway bind: lan"
echo "  - Gateway auth: token"
echo "  - Gateway token: $CLAWDIS_GATEWAY_TOKEN"
echo "  - Tailscale exposure: Off"
echo "  - Install Gateway daemon: No"
echo ""
docker compose -f "$COMPOSE_FILE" run --rm clawdis-cli onboard

echo ""
echo "==> WhatsApp login (QR will print in this terminal)"
docker compose -f "$COMPOSE_FILE" run --rm clawdis-cli login

echo ""
echo "==> Starting gateway"
docker compose -f "$COMPOSE_FILE" up -d clawdis-gateway

echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $CLAWDIS_CONFIG_DIR"
echo "Workspace: $CLAWDIS_WORKSPACE_DIR"
echo "Token: $CLAWDIS_GATEWAY_TOKEN"
echo ""
echo "Commands:"
echo "  docker compose -f $COMPOSE_FILE logs -f clawdis-gateway"
echo "  docker compose -f $COMPOSE_FILE exec clawdis-gateway node dist/index.js health --token \"$CLAWDIS_GATEWAY_TOKEN\""
