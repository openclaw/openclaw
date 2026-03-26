#!/usr/bin/env bash
# One-time host setup for rootless OpenClaw in Podman. Uses the current
# non-root user throughout, builds or pulls the image into that user's Podman
# store, writes config under ~/.openclaw by default, and installs the launch
# script to ~/.local/bin/run-openclaw-podman.sh.
#
# Usage: ./scripts/podman/setup.sh [--quadlet|--container]
#   --quadlet   Install a Podman Quadlet as the current user's systemd service
#   --container Only install image + launch script; you start the container manually (default)
#   Or set OPENCLAW_PODMAN_QUADLET=1 (or 0) to choose without a flag.
#
# After this, start the gateway manually:
#   ~/.local/bin/run-openclaw-podman.sh launch
#   ~/.local/bin/run-openclaw-podman.sh launch setup
# Or, if you used --quadlet:
#   systemctl --user start openclaw.service
set -euo pipefail

REPO_PATH="${OPENCLAW_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-openclaw-podman.sh"
QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/openclaw.container.in"
OPENCLAW_USER="$(id -un)"
OPENCLAW_HOME="${HOME:-}"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-}"
OPENCLAW_IMAGE="${OPENCLAW_PODMAN_IMAGE:-${OPENCLAW_IMAGE:-openclaw:local}}"
OPENCLAW_CONTAINER_NAME="${OPENCLAW_PODMAN_CONTAINER:-openclaw}"
LAUNCH_SCRIPT_DIR="${OPENCLAW_PODMAN_BIN_DIR:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

is_root() { [[ "$(id -u)" -eq 0 ]]; }

escape_sed_replacement_pipe_delim() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

resolve_user_home() {
  local user="$1"
  local home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [[ -z "$home" && -f /etc/passwd ]]; then
    home="$(awk -F: -v u="$user" '$1==u {print $6}' /etc/passwd 2>/dev/null || true)"
  fi
  if [[ -z "$home" ]]; then
    home="/home/$user"
  fi
  printf '%s' "$home"
}

generate_token_hex_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return 0
  fi
  if command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d " \n"
    return 0
  fi
  echo "Missing dependency: need openssl or python3 (or od) to generate OPENCLAW_GATEWAY_TOKEN." >&2
  exit 1
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { found = 0 }
      $0 ~ ("^" k "=") { print k "=" v; found = 1; next }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

INSTALL_QUADLET=false
for arg in "$@"; do
  case "$arg" in
    --quadlet) INSTALL_QUADLET=true ;;
    --container) INSTALL_QUADLET=false ;;
  esac
done
if [[ -n "${OPENCLAW_PODMAN_QUADLET:-}" ]]; then
  case "${OPENCLAW_PODMAN_QUADLET,,}" in
    1|yes|true) INSTALL_QUADLET=true ;;
    0|no|false) INSTALL_QUADLET=false ;;
  esac
fi

require_cmd podman
if is_root; then
  echo "Run scripts/podman/setup.sh as your normal user so Podman stays rootless." >&2
  exit 1
fi
if [[ ! -f "$REPO_PATH/Dockerfile" ]]; then
  echo "Dockerfile not found at $REPO_PATH. Set OPENCLAW_REPO_PATH to the repo root." >&2
  exit 1
fi
if [[ ! -f "$RUN_SCRIPT_SRC" ]]; then
  echo "Launch script not found at $RUN_SCRIPT_SRC." >&2
  exit 1
fi

if [[ -z "$OPENCLAW_HOME" ]]; then
  OPENCLAW_HOME="$(resolve_user_home "$OPENCLAW_USER")"
fi
if [[ -z "$OPENCLAW_HOME" ]]; then
  echo "Unable to resolve HOME for user $OPENCLAW_USER." >&2
  exit 1
fi
if [[ -z "$OPENCLAW_CONFIG_DIR" ]]; then
  OPENCLAW_CONFIG_DIR="$OPENCLAW_HOME/.openclaw"
fi
if [[ -z "$OPENCLAW_WORKSPACE_DIR" ]]; then
  OPENCLAW_WORKSPACE_DIR="$OPENCLAW_CONFIG_DIR/workspace"
fi
if [[ -z "$LAUNCH_SCRIPT_DIR" ]]; then
  LAUNCH_SCRIPT_DIR="$OPENCLAW_HOME/.local/bin"
fi
LAUNCH_SCRIPT_DST="$LAUNCH_SCRIPT_DIR/run-openclaw-podman.sh"

install -d -m 700 "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR"
install -d -m 755 "$LAUNCH_SCRIPT_DIR"

BUILD_ARGS=()
if [[ -n "${OPENCLAW_DOCKER_APT_PACKAGES:-}" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}")
fi
if [[ -n "${OPENCLAW_EXTENSIONS:-}" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS}")
fi

if [[ "$OPENCLAW_IMAGE" == "openclaw:local" ]]; then
  echo "Building image $OPENCLAW_IMAGE ..."
  podman build -t "$OPENCLAW_IMAGE" -f "$REPO_PATH/Dockerfile" "${BUILD_ARGS[@]}" "$REPO_PATH"
else
  if podman image exists "$OPENCLAW_IMAGE" >/dev/null 2>&1; then
    echo "Using existing image $OPENCLAW_IMAGE"
  else
    echo "Pulling image $OPENCLAW_IMAGE ..."
    podman pull "$OPENCLAW_IMAGE"
  fi
fi

echo "Installing launch script to $LAUNCH_SCRIPT_DST ..."
install -m 0755 "$RUN_SCRIPT_SRC" "$LAUNCH_SCRIPT_DST"

ENV_FILE="$OPENCLAW_CONFIG_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(generate_token_hex_32)"
  umask 077
  printf '%s\n' "OPENCLAW_GATEWAY_TOKEN=$TOKEN" >"$ENV_FILE"
  echo "Generated OPENCLAW_GATEWAY_TOKEN and wrote it to $ENV_FILE"
fi
upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_CONTAINER" "$OPENCLAW_CONTAINER_NAME"
upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_IMAGE" "$OPENCLAW_IMAGE"

CONFIG_JSON="$OPENCLAW_CONFIG_DIR/openclaw.json"
if [[ ! -f "$CONFIG_JSON" ]]; then
  umask 077
  cat >"$CONFIG_JSON" <<'JSON'
{ "gateway": { "mode": "local" } }
JSON
  echo "Wrote minimal config to $CONFIG_JSON"
fi

if [[ "$INSTALL_QUADLET" == true ]]; then
  QUADLET_DIR="$OPENCLAW_HOME/.config/containers/systemd"
  QUADLET_DST="$QUADLET_DIR/openclaw.container"
  echo "Installing Quadlet to $QUADLET_DST ..."
  mkdir -p "$QUADLET_DIR"
  OPENCLAW_HOME_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_HOME")"
  OPENCLAW_CONFIG_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_CONFIG_DIR")"
  OPENCLAW_WORKSPACE_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_WORKSPACE_DIR")"
  OPENCLAW_IMAGE_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_IMAGE")"
  OPENCLAW_CONTAINER_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_CONTAINER_NAME")"
  sed \
    -e "s|{{OPENCLAW_HOME}}|$OPENCLAW_HOME_ESCAPED|g" \
    -e "s|{{OPENCLAW_CONFIG_DIR}}|$OPENCLAW_CONFIG_ESCAPED|g" \
    -e "s|{{OPENCLAW_WORKSPACE_DIR}}|$OPENCLAW_WORKSPACE_ESCAPED|g" \
    -e "s|{{IMAGE_NAME}}|$OPENCLAW_IMAGE_ESCAPED|g" \
    -e "s|{{CONTAINER_NAME}}|$OPENCLAW_CONTAINER_ESCAPED|g" \
    "$QUADLET_TEMPLATE" >"$QUADLET_DST"
  chmod 0644 "$QUADLET_DST"

  if command -v systemctl >/dev/null 2>&1; then
    echo "Reloading and starting user service..."
    if systemctl --user daemon-reload && systemctl --user start openclaw.service; then
      echo "Quadlet installed and service started."
    else
      echo "Quadlet installed, but automatic start failed." >&2
      echo "Try: systemctl --user daemon-reload && systemctl --user start openclaw.service" >&2
      if command -v loginctl >/dev/null 2>&1; then
        echo "For boot persistence on headless hosts, you may also need: sudo loginctl enable-linger $(whoami)" >&2
      fi
    fi
  else
    echo "systemctl not found; Quadlet installed but not started." >&2
  fi
else
  echo "Container + launch script installed."
fi

echo
echo "Next:"
echo "  $LAUNCH_SCRIPT_DST launch"
echo "  $LAUNCH_SCRIPT_DST launch setup"
echo "  openclaw --container $OPENCLAW_CONTAINER_NAME dashboard --no-open"
