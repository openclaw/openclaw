#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
EXTRA_MOUNTS="${OPENCLAW_EXTRA_MOUNTS:-}"
HOME_VOLUME_NAME="${OPENCLAW_HOME_VOLUME:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

# Find container runtime (container, docker, or podman)
if command -v container >/dev/null 2>&1; then
  CONTAINER_CMD="container"
elif command -v docker >/dev/null 2>&1; then
  CONTAINER_CMD="docker"
elif command -v podman >/dev/null 2>&1; then
  CONTAINER_CMD="podman"
else
  echo "Error: No container runtime found. Install 'container', 'docker', or 'podman'" >&2
  exit 1
fi

if ! "$CONTAINER_CMD" images ls >/dev/null 2>&1; then
  echo "Warning: Container runtime not responding. Try: $CONTAINER_CMD system start" >&2
fi

OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"

mkdir -p "$OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"

export OPENCLAW_CONFIG_DIR
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_IMAGE="$IMAGE_NAME"
export OPENCLAW_DOCKER_APT_PACKAGES="${OPENCLAW_DOCKER_APT_PACKAGES:-}"
export OPENCLAW_EXTRA_MOUNTS="$EXTRA_MOUNTS"
export OPENCLAW_HOME_VOLUME="$HOME_VOLUME_NAME"

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
export OPENCLAW_GATEWAY_TOKEN

ENV_FILE="$ROOT_DIR/.env"
upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"
  local seen=" "

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      local key="${line%%=*}"
      local replaced=false
      for k in "${keys[@]}"; do
        if [[ "$key" == "$k" ]]; then
          printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
          seen="$seen$k "
          replaced=true
          break
        fi
      done
      if [[ "$replaced" == false ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  for k in ${keys[@]+"${keys[@]}"}; do
    if [[ "$seen" != *" $k "* ]]; then
      printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
    fi
  done

  mv "$tmp" "$file"
}

upsert_env "$ENV_FILE" OPENCLAW_CONFIG_DIR OPENCLAW_WORKSPACE_DIR OPENCLAW_GATEWAY_PORT OPENCLAW_BRIDGE_PORT OPENCLAW_GATEWAY_BIND OPENCLAW_GATEWAY_TOKEN OPENCLAW_IMAGE OPENCLAW_EXTRA_MOUNTS OPENCLAW_HOME_VOLUME OPENCLAW_DOCKER_APT_PACKAGES

echo "==> Building container image: $IMAGE_NAME"
"$CONTAINER_CMD" build \
  --build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}" \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/Dockerfile" \
  "$ROOT_DIR"

COMMON_ARGS=(
  -e HOME=/home/node
  -e TERM=xterm-256color
  -e NODE_OPTIONS="--max-old-space-size=2048"
  -e OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN"
  -e CLAUDE_AI_SESSION_KEY="${CLAUDE_AI_SESSION_KEY:-}"
  -e CLAUDE_WEB_SESSION_KEY="${CLAUDE_WEB_SESSION_KEY:-}"
  -e CLAUDE_WEB_COOKIE="${CLAUDE_WEB_COOKIE:-}"
  -v "$OPENCLAW_CONFIG_DIR:/home/node/.openclaw"
  -v "$OPENCLAW_WORKSPACE_DIR:/home/node/.openclaw/workspace"
)

if [[ -n "$HOME_VOLUME_NAME" ]]; then
  COMMON_ARGS+=(-v "$HOME_VOLUME_NAME:/home/node")
fi

if [[ -n "$EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a mounts <<<"$EXTRA_MOUNTS"
  for mount in "${mounts[@]}"; do
    mount="${mount#"${mount%%[![:space:]]*}"}"
    mount="${mount%"${mount##*[![:space:]]}"}"
    if [[ -n "$mount" ]]; then
      COMMON_ARGS+=(-v "$mount")
    fi
  done
fi

echo ""
echo "==> Onboarding (interactive)"
echo "When prompted:"
echo "  - Gateway bind: lan"
echo "  - Gateway auth: token"
echo "  - Gateway token: $OPENCLAW_GATEWAY_TOKEN"
echo "  - Tailscale exposure: Off"
echo "  - Install Gateway daemon: No"
echo ""

if [[ -t 0 ]]; then
  # Running in terminal - use interactive mode
  # Try to use timeout with 5-minute limit, but don't fail if timeout command doesn't exist
  if command -v timeout >/dev/null 2>&1; then
    timeout 300 "$CONTAINER_CMD" run --rm -it \
      --memory 2g \
      "${COMMON_ARGS[@]}" \
      -e BROWSER=echo \
      "$IMAGE_NAME" node dist/index.js onboard --no-install-daemon || true
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 300 "$CONTAINER_CMD" run --rm -it \
      --memory 2g \
      "${COMMON_ARGS[@]}" \
      -e BROWSER=echo \
      "$IMAGE_NAME" node dist/index.js onboard --no-install-daemon || true
  else
    "$CONTAINER_CMD" run --rm -it \
      --memory 2g \
      "${COMMON_ARGS[@]}" \
      -e BROWSER=echo \
      "$IMAGE_NAME" node dist/index.js onboard --no-install-daemon || true
  fi
else
  # Not in terminal - use non-interactive mode
  "$CONTAINER_CMD" run --rm \
    --memory 2g \
    "${COMMON_ARGS[@]}" \
    -e BROWSER=echo \
    "$IMAGE_NAME" node dist/index.js onboard --no-install-daemon
fi

echo ""
echo "==> Starting gateway"
"$CONTAINER_CMD" rm -f openclaw-gateway >/dev/null 2>&1 || true

"$CONTAINER_CMD" run -d --name openclaw-gateway \
  --memory 2g \
  "${COMMON_ARGS[@]}" \
  -p "$OPENCLAW_GATEWAY_PORT:18789" \
  -p "$OPENCLAW_BRIDGE_PORT:18790" \
  "$IMAGE_NAME" node dist/index.js gateway --bind "$OPENCLAW_GATEWAY_BIND" --port 18789

echo ""
echo "==> Provider setup (optional)"
echo "WhatsApp (QR):"
echo "  $CONTAINER_CMD exec openclaw-gateway node dist/index.js channels login"
echo "Telegram (bot token):"
echo "  $CONTAINER_CMD exec openclaw-gateway node dist/index.js channels add --channel telegram --token <token>"
echo "Discord (bot token):"
echo "  $CONTAINER_CMD exec openclaw-gateway node dist/index.js channels add --channel discord --token <token>"
echo "Docs: https://docs.openclaw.ai/channels"
echo ""
echo "==> Control UI & Device Pairing"
echo "If you see 'unauthorized' or 'disconnected (1008): pairing required':"
echo "  $CONTAINER_CMD exec openclaw-gateway node dist/index.js dashboard --no-open"
echo "  $CONTAINER_CMD exec openclaw-gateway node dist/index.js devices list"
echo "  $CONTAINER_CMD exec openclaw-gateway node dist/index.js devices approve <requestId>"
echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $OPENCLAW_CONFIG_DIR"
echo "Workspace: $OPENCLAW_WORKSPACE_DIR"
echo "Token: $OPENCLAW_GATEWAY_TOKEN"
echo ""
echo "Commands:"
echo "  $CONTAINER_CMD logs -f openclaw-gateway"
echo "  $CONTAINER_CMD exec openclaw-gateway node dist/index.js health --token \"$OPENCLAW_GATEWAY_TOKEN\""
