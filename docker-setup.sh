#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
EXTRA_COMPOSE_FILE="$ROOT_DIR/docker-compose.extra.yml"
SANDBOX_COMPOSE_FILE="$ROOT_DIR/docker-compose.sandbox.yml"
IMAGE_NAME="${BOT_IMAGE:-bot:local}"
EXTRA_MOUNTS="${BOT_EXTRA_MOUNTS:-}"
HOME_VOLUME_NAME="${BOT_HOME_VOLUME:-}"

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

# --- Input validation ---

# Reject control characters (newlines, tabs) in BOT_EXTRA_MOUNTS to prevent
# YAML injection into the generated docker-compose.extra.yml overlay.
# Use tr to detect control chars portably (grep -P is not available on macOS).
if [[ -n "$EXTRA_MOUNTS" ]]; then
  _cleaned="$(printf '%s' "$EXTRA_MOUNTS" | tr -d '[:cntrl:]')"
  if [[ "$_cleaned" != "$EXTRA_MOUNTS" ]]; then
    echo "BOT_EXTRA_MOUNTS cannot contain control characters" >&2
    exit 1
  fi
fi

# Validate each mount entry has the host:container colon-separated format.
if [[ -n "$EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a _validate_mounts <<<"$EXTRA_MOUNTS"
  for _vm in "${_validate_mounts[@]}"; do
    _vm="${_vm#"${_vm%%[![:space:]]*}"}"
    _vm="${_vm%"${_vm##*[![:space:]]}"}"
    if [[ -n "$_vm" && "$_vm" != *":"* ]]; then
      echo "Invalid mount format: '$_vm' (expected host:container)" >&2
      exit 1
    fi
  done
fi

# Validate BOT_HOME_VOLUME matches Docker named volume pattern.
if [[ -n "$HOME_VOLUME_NAME" ]] && ! printf '%s' "$HOME_VOLUME_NAME" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'; then
  echo "BOT_HOME_VOLUME must match [a-zA-Z0-9][a-zA-Z0-9_.-]* (got '$HOME_VOLUME_NAME')" >&2
  exit 1
fi

# --- Resolve sandbox flag ---

# Derive sandbox enabled state from BOT_SANDBOX env var.
# "0", "false", "no", and empty are treated as disabled.
SANDBOX_ENABLED=""
case "${BOT_SANDBOX:-}" in
  1|true|yes) SANDBOX_ENABLED=1 ;;
esac
export BOT_SANDBOX="${BOT_SANDBOX:-}"

BOT_CONFIG_DIR="${BOT_CONFIG_DIR:-$HOME/.bot}"
BOT_WORKSPACE_DIR="${BOT_WORKSPACE_DIR:-$HOME/.hanzo/bot/workspace}"

mkdir -p "$BOT_CONFIG_DIR"
mkdir -p "$BOT_WORKSPACE_DIR"

# Pre-create identity directory so the CLI can write device auth files
# without hitting EACCES in the container.
mkdir -p "$BOT_CONFIG_DIR/identity"

# Pre-create agent data directories to avoid EACCES when the container
# tries to write session and agent data.
mkdir -p "$BOT_CONFIG_DIR/agents/main/agent"
mkdir -p "$BOT_CONFIG_DIR/agents/main/sessions"

export BOT_CONFIG_DIR
export BOT_WORKSPACE_DIR
export BOT_GATEWAY_PORT="${BOT_GATEWAY_PORT:-18789}"
export BOT_BRIDGE_PORT="${BOT_BRIDGE_PORT:-18790}"
export BOT_GATEWAY_BIND="${BOT_GATEWAY_BIND:-lan}"
export BOT_IMAGE="$IMAGE_NAME"
export BOT_DOCKER_APT_PACKAGES="${BOT_DOCKER_APT_PACKAGES:-}"
export BOT_EXTRA_MOUNTS="$EXTRA_MOUNTS"
export BOT_HOME_VOLUME="$HOME_VOLUME_NAME"

# Reuse gateway token from existing config if BOT_GATEWAY_TOKEN is not set.
if [[ -z "${BOT_GATEWAY_TOKEN:-}" ]]; then
  config_file="$BOT_CONFIG_DIR/bot.json"
  if [[ -f "$config_file" ]] && command -v python3 >/dev/null 2>&1; then
    existing_token="$(python3 -c "
import json, sys
try:
    cfg = json.load(open('$config_file'))
    token = cfg.get('gateway', {}).get('auth', {}).get('token', '')
    if token:
        print(token, end='')
except Exception:
    pass
" 2>/dev/null || true)"
    if [[ -n "$existing_token" ]]; then
      BOT_GATEWAY_TOKEN="$existing_token"
    fi
  fi
fi

if [[ -z "${BOT_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    BOT_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    BOT_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
fi
export BOT_GATEWAY_TOKEN

COMPOSE_FILES=("$COMPOSE_FILE")
COMPOSE_ARGS=()

write_extra_compose() {
  local home_volume="$1"
  shift
  local mount

  cat >"$EXTRA_COMPOSE_FILE" <<'YAML'
services:
  bot-gateway:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s:/home/node\n' "$home_volume" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.bot\n' "$BOT_CONFIG_DIR" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.hanzo/bot/workspace\n' "$BOT_WORKSPACE_DIR" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  cat >>"$EXTRA_COMPOSE_FILE" <<'YAML'
  bot-cli:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s:/home/node\n' "$home_volume" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.bot\n' "$BOT_CONFIG_DIR" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.hanzo/bot/workspace\n' "$BOT_WORKSPACE_DIR" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  if [[ -n "$home_volume" && "$home_volume" != *"/"* ]]; then
    cat >>"$EXTRA_COMPOSE_FILE" <<YAML
volumes:
  ${home_volume}:
YAML
  fi
}

# When sandbox is requested, ensure Docker CLI build arg is set for local builds.
# Docker socket mount is deferred until sandbox prerequisites are verified.
export BOT_INSTALL_DOCKER_CLI="${BOT_INSTALL_DOCKER_CLI:-}"
if [[ -n "$SANDBOX_ENABLED" ]]; then
  if [[ -z "$BOT_INSTALL_DOCKER_CLI" ]]; then
    export BOT_INSTALL_DOCKER_CLI=1
  fi
fi

VALID_MOUNTS=()
if [[ -n "$EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a mounts <<<"$EXTRA_MOUNTS"
  for mount in "${mounts[@]}"; do
    mount="${mount#"${mount%%[![:space:]]*}"}"
    mount="${mount%"${mount##*[![:space:]]}"}"
    if [[ -n "$mount" ]]; then
      VALID_MOUNTS+=("$mount")
    fi
  done
fi

if [[ -n "$HOME_VOLUME_NAME" || ${#VALID_MOUNTS[@]} -gt 0 ]]; then
  # Bash 3.2 + nounset treats "${array[@]}" on an empty array as unbound.
  if [[ ${#VALID_MOUNTS[@]} -gt 0 ]]; then
    write_extra_compose "$HOME_VOLUME_NAME" "${VALID_MOUNTS[@]}"
  else
    write_extra_compose "$HOME_VOLUME_NAME"
  fi
  COMPOSE_FILES+=("$EXTRA_COMPOSE_FILE")
fi
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_ARGS+=("-f" "$compose_file")
done
# Keep a base compose arg set without sandbox overlay so rollback paths can
# force a known-safe gateway service definition (no docker.sock mount).
BASE_COMPOSE_ARGS=("${COMPOSE_ARGS[@]}")
COMPOSE_HINT="docker compose"
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_HINT+=" -f ${compose_file}"
done

ENV_FILE="$ROOT_DIR/.env"
upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"
  # Use a delimited string instead of an associative array so the script
  # works with Bash 3.2 (macOS default) which lacks `declare -A`.
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

  for k in "${keys[@]}"; do
    if [[ "$seen" != *" $k "* ]]; then
      printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
    fi
  done

  mv "$tmp" "$file"
}

upsert_env "$ENV_FILE" \
  BOT_CONFIG_DIR \
  BOT_WORKSPACE_DIR \
  BOT_GATEWAY_PORT \
  BOT_BRIDGE_PORT \
  BOT_GATEWAY_BIND \
  BOT_GATEWAY_TOKEN \
  BOT_IMAGE \
  BOT_EXTRA_MOUNTS \
  BOT_HOME_VOLUME \
  BOT_DOCKER_APT_PACKAGES \
  BOT_SANDBOX

echo "==> Building Docker image: $IMAGE_NAME"
docker build \
  --build-arg "BOT_DOCKER_APT_PACKAGES=${BOT_DOCKER_APT_PACKAGES}" \
  --build-arg "BOT_INSTALL_DOCKER_CLI=${BOT_INSTALL_DOCKER_CLI}" \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/Dockerfile" \
  "$ROOT_DIR"

# Ensure bind-mounted data directories are writable by the container's `node`
# user (uid 1000). Host-created dirs inherit the host user's uid which may
# differ, causing EACCES when the container tries to mkdir/write.
# Running a brief root container to chown is the portable Docker idiom --
# it works regardless of the host uid and doesn't require host-side root.
echo ""
echo "==> Fixing data-directory permissions"
# Use -xdev to restrict chown to the config-dir mount only — without it,
# the recursive chown would cross into the workspace bind mount and rewrite
# ownership of all user project files on Linux hosts.
# After fixing the config dir, only the Bot metadata subdirectory
# (.hanzo/bot/) inside the workspace gets chowned, not the user's project files.
docker compose "${COMPOSE_ARGS[@]}" run --rm --user root --entrypoint sh bot-cli -c \
  'find /home/node/.bot -xdev -exec chown node:node {} +; \
   [ -d /home/node/.hanzo/bot/workspace/.bot ] && chown -R node:node /home/node/.hanzo/bot/workspace/.bot || true'

echo ""
echo "==> Onboarding (interactive)"
echo "When prompted:"
echo "  - Gateway bind: lan"
echo "  - Gateway auth: token"
echo "  - Gateway token: $BOT_GATEWAY_TOKEN"
echo "  - Tailscale exposure: Off"
echo "  - Install Gateway daemon: No"
echo ""
docker compose "${COMPOSE_ARGS[@]}" run --rm bot-cli onboard --mode local --no-install-daemon

# Apply gateway configuration defaults.
docker compose "${COMPOSE_ARGS[@]}" run --rm bot-cli config set gateway.mode local
docker compose "${COMPOSE_ARGS[@]}" run --rm bot-cli config set gateway.bind lan

# --- Sandbox configuration ---

GATEWAY_STARTED=""
if [[ -n "$SANDBOX_ENABLED" ]]; then
  # Verify the Docker CLI is available inside the gateway image.
  DOCKER_CLI_OK=""
  if docker compose "${COMPOSE_ARGS[@]}" run --rm --entrypoint docker bot-gateway --version >/dev/null 2>&1; then
    DOCKER_CLI_OK=1
  fi

  if [[ -z "$DOCKER_CLI_OK" ]]; then
    echo "Sandbox requires Docker CLI inside the gateway image; skipping sandbox setup." >&2
    SANDBOX_ENABLED=""
  fi
fi

if [[ -n "$SANDBOX_ENABLED" ]]; then
  # Start the gateway first so sandbox config writes can run against it.
  docker compose "${COMPOSE_ARGS[@]}" up -d bot-gateway

  # Write sandbox configuration via CLI config commands.
  SANDBOX_CONFIG_OK=1

  if ! docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps bot-cli config set agents.defaults.sandbox.mode non-main 2>/dev/null; then
    echo "Failed to set agents.defaults.sandbox.mode" >&2
    SANDBOX_CONFIG_OK=""
  fi

  if ! docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps bot-cli config set agents.defaults.sandbox.scope session 2>/dev/null; then
    echo "Failed to set agents.defaults.sandbox.scope" >&2
    SANDBOX_CONFIG_OK=""
  fi

  if [[ -z "$SANDBOX_CONFIG_OK" ]]; then
    echo "Skipping gateway restart to avoid exposing Docker socket with incomplete sandbox config." >&2
    # Reset sandbox mode to off since config is incomplete.
    docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps bot-cli config set agents.defaults.sandbox.mode off 2>/dev/null || true
    # Remove sandbox overlay to ensure no docker.sock mount remains.
    rm -f "$SANDBOX_COMPOSE_FILE"
    # Force-recreate gateway without the sandbox overlay.
    docker compose "${BASE_COMPOSE_ARGS[@]}" up -d --force-recreate bot-gateway
    GATEWAY_STARTED=1
  else
    # Generate sandbox compose overlay with docker.sock mount.
    BOT_DOCKER_SOCKET="${BOT_DOCKER_SOCKET:-/var/run/docker.sock}"
    cat >"$SANDBOX_COMPOSE_FILE" <<YAML
services:
  bot-gateway:
    volumes:
      - ${BOT_DOCKER_SOCKET}:/var/run/docker.sock
YAML
    COMPOSE_FILES+=("$SANDBOX_COMPOSE_FILE")
    COMPOSE_ARGS=()
    for compose_file in "${COMPOSE_FILES[@]}"; do
      COMPOSE_ARGS+=("-f" "$compose_file")
    done
    docker compose "${COMPOSE_ARGS[@]}" up -d --force-recreate bot-gateway
    GATEWAY_STARTED=1
  fi
else
  # When sandbox is not active, clean up stale sandbox state.
  docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps bot-cli config set agents.defaults.sandbox.mode off 2>/dev/null || true
  rm -f "$SANDBOX_COMPOSE_FILE"
fi

echo ""
echo "==> Provider setup (optional)"
echo "WhatsApp (QR):"
echo "  ${COMPOSE_HINT} run --rm bot-cli channels login"
echo "Telegram (bot token):"
echo "  ${COMPOSE_HINT} run --rm bot-cli channels add --channel telegram --token <token>"
echo "Discord (bot token):"
echo "  ${COMPOSE_HINT} run --rm bot-cli channels add --channel discord --token <token>"
echo "Docs: https://docs.hanzo.bot/channels"

if [[ -z "$GATEWAY_STARTED" ]]; then
  echo ""
  echo "==> Starting gateway"
  docker compose "${COMPOSE_ARGS[@]}" up -d bot-gateway
fi

echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $BOT_CONFIG_DIR"
echo "Workspace: $BOT_WORKSPACE_DIR"
echo "Token: $BOT_GATEWAY_TOKEN"
echo ""
echo "Commands:"
echo "  ${COMPOSE_HINT} logs -f bot-gateway"
echo "  ${COMPOSE_HINT} exec bot-gateway node dist/index.js health --token \"$BOT_GATEWAY_TOKEN\""
