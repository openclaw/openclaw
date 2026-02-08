#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
ENV_FILE="$ROOT_DIR/.env"

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

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-openclaw:local}"
OPENCLAW_DOCKER_APT_PACKAGES="${OPENCLAW_DOCKER_APT_PACKAGES:-}"
OPENCLAW_EXTRA_MOUNTS="${OPENCLAW_EXTRA_MOUNTS:-}"
OPENCLAW_HOME_VOLUME="${OPENCLAW_HOME_VOLUME:-}"

mkdir -p "$OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    OPENCLAW_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
fi

export OPENCLAW_CONFIG_DIR
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_GATEWAY_PORT
export OPENCLAW_BRIDGE_PORT
export OPENCLAW_GATEWAY_BIND
export OPENCLAW_IMAGE
export OPENCLAW_GATEWAY_TOKEN
export OPENCLAW_DOCKER_APT_PACKAGES
export OPENCLAW_EXTRA_MOUNTS
export OPENCLAW_HOME_VOLUME

upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"

  if [[ -f "$file" ]]; then
    cp "$file" "$tmp"
  else
    : >"$tmp"
  fi

  for k in "${keys[@]}"; do
    grep -v "^${k}=" "$tmp" >"${tmp}.next" || true
    mv "${tmp}.next" "$tmp"
    printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
  done

  mv "$tmp" "$file"
}

upsert_env "$ENV_FILE" \
  OPENCLAW_CONFIG_DIR \
  OPENCLAW_WORKSPACE_DIR \
  OPENCLAW_GATEWAY_PORT \
  OPENCLAW_BRIDGE_PORT \
  OPENCLAW_GATEWAY_BIND \
  OPENCLAW_GATEWAY_TOKEN \
  OPENCLAW_IMAGE \
  OPENCLAW_DOCKER_APT_PACKAGES \
  OPENCLAW_EXTRA_MOUNTS \
  OPENCLAW_HOME_VOLUME

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

wait_for_health() {
  local attempts=30
  local sleep_seconds=2
  for ((i = 1; i <= attempts; i++)); do
    if compose exec -T openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done
  return 1
}

start_stack() {
  echo "==> Stopping existing Docker stack (if running)"
  compose down --remove-orphans || true

  echo "==> Building image: $OPENCLAW_IMAGE"
  docker build \
    --build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}" \
    -t "$OPENCLAW_IMAGE" \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR"

  echo "==> Starting gateway container"
  compose up -d openclaw-gateway

  if wait_for_health; then
    echo "==> Gateway health check: OK"
  else
    echo "==> Gateway health check: not ready yet (continuing)" >&2
  fi

  local dashboard_url="http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/"
  echo ""
  echo "Dashboard: $dashboard_url"
  echo "Token: $OPENCLAW_GATEWAY_TOKEN"
  echo "Logs: docker compose -f $COMPOSE_FILE logs -f openclaw-gateway"
  echo "Stop: docker compose -f $COMPOSE_FILE down --remove-orphans"

  if [[ "${OPENCLAW_NO_OPEN:-0}" != "1" ]] && command -v open >/dev/null 2>&1; then
    open "$dashboard_url" >/dev/null 2>&1 || true
  fi
}

stop_stack() {
  echo "==> Stopping Docker stack"
  compose down --remove-orphans
}

show_status() {
  compose ps
}

show_logs() {
  compose logs -f openclaw-gateway
}

usage() {
  cat <<'EOF'
Usage: scripts/docker-one-click.sh [start|stop|status|logs]

Commands:
  start   Stop existing stack, build image, start gateway, and open dashboard (macOS)
  stop    Stop stack (keeps volumes)
  status  Show compose service status
  logs    Tail gateway logs
EOF
}

command_name="${1:-start}"
case "$command_name" in
start)
  start_stack
  ;;
stop)
  stop_stack
  ;;
status)
  show_status
  ;;
logs)
  show_logs
  ;;
*)
  usage
  exit 1
  ;;
esac
