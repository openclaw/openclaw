#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="$ROOT_DIR/scripts/docker/setup.sh"

HOST_ROOT="${OPENCLAW_HOST_ROOT:-$HOME/Documents/OpenClaw}"
CONFIG_DIR="$HOST_ROOT/.openclaw"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${OPENCLAW_WORKSPACE_ROOT:-$HOST_ROOT/workspace}}"
HOME_BIND_DIR="$CONFIG_DIR/home"
PLAYWRIGHT_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-/home/node/.cache/ms-playwright}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing dependency: $1"
  fi
}

validate_no_whitespace() {
  local label="$1"
  local value="$2"
  if [[ "$value" =~ [[:space:]] ]]; then
    fail "$label cannot contain whitespace: $value"
  fi
}

append_compose_file_if_present() {
  local file="$1"
  if [[ -f "$file" ]]; then
    COMPOSE_ARGS+=("-f" "$file")
  fi
}

run_cli() {
  docker compose "${COMPOSE_ARGS[@]}" run --rm \
    -e "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_CACHE" \
    openclaw-cli "$@"
}

run_cli_node() {
  docker compose "${COMPOSE_ARGS[@]}" run --rm \
    --entrypoint node \
    -e "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_CACHE" \
    openclaw-cli "$@"
}

if [[ ! -f "$SETUP_SCRIPT" ]]; then
  fail "Docker setup script not found at $SETUP_SCRIPT"
fi

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose v2 is required."
fi

validate_no_whitespace "OPENCLAW_HOST_ROOT" "$HOST_ROOT"
validate_no_whitespace "CONFIG_DIR" "$CONFIG_DIR"
validate_no_whitespace "HOME_BIND_DIR" "$HOME_BIND_DIR"

if [[ -n "${OPENCLAW_EXTRA_MOUNTS:-}" ]]; then
  fail "This setup intentionally blocks OPENCLAW_EXTRA_MOUNTS so OpenClaw only sees $HOST_ROOT."
fi

mkdir -p "$HOST_ROOT" "$CONFIG_DIR" "$HOME_BIND_DIR"

export OPENCLAW_CONFIG_DIR="$CONFIG_DIR"
export OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR"
export OPENCLAW_HOME_VOLUME="$HOME_BIND_DIR"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_DOCKER_APT_PACKAGES="${OPENCLAW_DOCKER_APT_PACKAGES:-git curl jq}"
export OPENCLAW_BUNDLED_PLUGINS_DIR="${OPENCLAW_BUNDLED_PLUGINS_DIR:-/app/extensions}"
export PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_CACHE"
export OPENCLAW_EXTRA_MOUNTS=""

CONTROL_UI_URL="http://127.0.0.1:18789/"
if [[ "$OPENCLAW_GATEWAY_BIND" == "lan" ]]; then
  HOST_LAN_IP="$( (hostname -I 2>/dev/null || true) | awk '{print $1}' )"
  if [[ -n "$HOST_LAN_IP" ]]; then
    CONTROL_UI_URL="http://$HOST_LAN_IP:18789/"
  else
    CONTROL_UI_URL="http://<host-lan-ip>:18789/"
  fi
fi

echo "OpenClaw Docker profile"
echo "  Host root: $HOST_ROOT"
echo "  Config: $CONFIG_DIR"
echo "  Workspace: $WORKSPACE_DIR"
echo "  Container home bind: $HOME_BIND_DIR"
echo "  Playwright cache: $PLAYWRIGHT_CACHE"
echo "  Bundled plugins dir: $OPENCLAW_BUNDLED_PLUGINS_DIR"
echo ""

"$SETUP_SCRIPT" "$@"

declare -a COMPOSE_ARGS=("-f" "$ROOT_DIR/docker-compose.yml")
append_compose_file_if_present "$ROOT_DIR/docker-compose.extra.yml"
append_compose_file_if_present "$ROOT_DIR/docker-compose.sandbox.yml"

echo ""
echo "==> Installing Chromium for Playwright"
run_cli_node /app/node_modules/playwright-core/cli.js install chromium

echo ""
echo "==> Restarting gateway after Playwright browser install"
docker compose "${COMPOSE_ARGS[@]}" up -d openclaw-gateway

if [[ "${OPENCLAW_SKIP_WHATSAPP_LOGIN:-0}" != "1" && -t 0 ]]; then
  echo ""
  read -r -p "Start WhatsApp linking now? [Y/n] " start_whatsapp
  case "${start_whatsapp:-y}" in
    y | Y | yes | YES | "")
      echo "==> WhatsApp link flow"
      run_cli channels login --channel whatsapp
      ;;
  esac
fi

echo ""
echo "Setup complete."
echo "Open the Control UI at $CONTROL_UI_URL"
if [[ "$OPENCLAW_GATEWAY_BIND" == "lan" && "$CONTROL_UI_URL" == "http://<host-lan-ip>:18789/" ]]; then
  echo "OPENCLAW_GATEWAY_BIND=lan, so use your host LAN IP if auto-detection failed."
fi
echo "If you skipped WhatsApp linking, run:"
echo "  docker compose ${COMPOSE_ARGS[*]} run --rm openclaw-cli channels login --channel whatsapp"
