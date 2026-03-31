#!/usr/bin/env bash
# One-time host setup for rootless OpenClaw in Podman. Uses the current
# non-root user throughout, builds or pulls the image into that user's Podman
# store, writes config under ~/.openclaw by default, and installs the launch
# helper under ~/.local/bin.
#
# Usage: ./scripts/podman/setup.sh [--quadlet|--container]
#   --quadlet   Install a Podman Quadlet as the current user's systemd service
#   --container Only install image + config; you start the container manually (default)
#   Or set OPENCLAW_PODMAN_QUADLET=1 (or 0) to choose without a flag.
#
# After this, start the gateway manually:
#   ./scripts/run-openclaw-podman.sh launch
#   ./scripts/run-openclaw-podman.sh launch setup
# Or, if you used --quadlet:
#   systemctl --user start openclaw.service
set -euo pipefail

OPENCLAW_HOME="${HOME:-}"
OPENCLAW_IMAGE="${OPENCLAW_PODMAN_IMAGE:-${OPENCLAW_IMAGE:-openclaw:local}}"
OPENCLAW_CONTAINER_NAME="${OPENCLAW_PODMAN_CONTAINER:-openclaw}"
REPO_PATH="${OPENCLAW_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-openclaw-podman.sh"
QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/openclaw.container.in"
PLATFORM_NAME="$(uname -s 2>/dev/null || echo unknown)"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

is_root() { [[ "$(id -u)" -eq 0 ]]; }

fail() {
  echo "$*" >&2
  exit 1
}

escape_sed_replacement_pipe_delim() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp "$(dirname "$file")/.env.tmp.XXXXXX")"
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

# Quadlet: opt-in via --quadlet or OPENCLAW_PODMAN_QUADLET=1
INSTALL_QUADLET=false
for arg in "$@"; do
  case "$arg" in
    --quadlet)   INSTALL_QUADLET=true ;;
    --container) INSTALL_QUADLET=false ;;
  esac
done
if [[ -n "${OPENCLAW_PODMAN_QUADLET:-}" ]]; then
  case "${OPENCLAW_PODMAN_QUADLET,,}" in
    1|yes|true)  INSTALL_QUADLET=true ;;
    0|no|false) INSTALL_QUADLET=false ;;
  esac
fi
if [[ "$INSTALL_QUADLET" == true && "$PLATFORM_NAME" != "Linux" ]]; then
  fail "--quadlet is only supported on Linux with systemd user services."
fi

require_cmd podman
if is_root; then
  echo "Run scripts/podman/setup.sh as your normal user so Podman stays rootless." >&2
  exit 1
fi
if [[ "$OPENCLAW_IMAGE" == "openclaw:local" ]] && [[ ! -f "$REPO_PATH/Dockerfile" ]]; then
  echo "Dockerfile not found at $REPO_PATH. Set OPENCLAW_REPO_PATH to the repo root." >&2
  exit 1
fi
if [[ ! -f "$RUN_SCRIPT_SRC" ]]; then
  echo "Launch script not found at $RUN_SCRIPT_SRC." >&2
  exit 1
fi

if [[ -z "$OPENCLAW_HOME" ]]; then
  echo "HOME is not set. Cannot determine config directory." >&2
  exit 1
fi

OPENCLAW_CONFIG="${OPENCLAW_CONFIG_DIR:-$OPENCLAW_HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="$OPENCLAW_CONFIG/workspace"

install -d -m 700 "$OPENCLAW_CONFIG" "$OPENCLAW_WORKSPACE_DIR"

# Image: build local, or use/pull a pre-built image.
BUILD_ARGS=()
if [[ -n "${OPENCLAW_DOCKER_APT_PACKAGES:-}" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}")
fi
if [[ -n "${OPENCLAW_EXTENSIONS:-}" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS}")
fi

if [[ "$OPENCLAW_IMAGE" == "openclaw:local" ]]; then
  echo "Building image $OPENCLAW_IMAGE ..."
  podman build -t "$OPENCLAW_IMAGE" -f "$REPO_PATH/Dockerfile" "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" "$REPO_PATH"
else
  if podman image exists "$OPENCLAW_IMAGE" >/dev/null 2>&1; then
    echo "Using existing image $OPENCLAW_IMAGE"
  else
    echo "Pulling image $OPENCLAW_IMAGE ..."
    podman pull "$OPENCLAW_IMAGE"
  fi
fi

# Install the launch helper into the user's PATH.
LAUNCH_BIN_DIR="$HOME/.local/bin"
mkdir -p "$LAUNCH_BIN_DIR"
install -m 0755 "$RUN_SCRIPT_SRC" "$LAUNCH_BIN_DIR/run-openclaw-podman.sh"
echo "Installed launch helper to $LAUNCH_BIN_DIR/run-openclaw-podman.sh"

ENV_FILE="$OPENCLAW_CONFIG/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(generate_token_hex_32)"
  (
    umask 077
    printf '%s\n' "OPENCLAW_GATEWAY_TOKEN=$TOKEN" > "$ENV_FILE"
  )
  echo "Generated OPENCLAW_GATEWAY_TOKEN and wrote it to $ENV_FILE"
fi
upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_CONTAINER" "$OPENCLAW_CONTAINER_NAME"
upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_IMAGE" "$OPENCLAW_IMAGE"

# Select a usable interactive shell for the container and persist it.
# The image is known to include zsh, bash, and sh (see Dockerfile); prefer the
# installer's own shell if it is in that set, otherwise fall back to zsh.
INSTALLER_SHELL="$(basename "${SHELL:-sh}")"
# Allow only safe characters for a shell executable name (alphanumeric, underscore, dash).
if [[ ! "$INSTALLER_SHELL" =~ ^[A-Za-z0-9_-]+$ ]]; then
  INSTALLER_SHELL="sh"
fi
CONTAINER_SHELL="sh"
for candidate in zsh bash sh; do
  if [[ "$INSTALLER_SHELL" == "$candidate" ]]; then
    CONTAINER_SHELL="$INSTALLER_SHELL"
    break
  fi
done
# If the installer's shell is not in the known set, zsh is the preferred default.
if [[ "$CONTAINER_SHELL" == "sh" && "$INSTALLER_SHELL" != "sh" ]]; then
  CONTAINER_SHELL="zsh"
fi
upsert_env_var "$ENV_FILE" "OPENCLAW_CONTAINER_SHELL" "$CONTAINER_SHELL"
echo "Set OPENCLAW_CONTAINER_SHELL=$CONTAINER_SHELL in $ENV_FILE"

CONFIG_JSON="$OPENCLAW_CONFIG/openclaw.json"
if [[ ! -f "$CONFIG_JSON" ]]; then
  (
    umask 077
    cat > "$CONFIG_JSON" <<JSON
{
  "gateway": {
    "mode": "local",
    "controlUi": {
      "allowedOrigins": ["http://127.0.0.1:18789", "http://localhost:18789"]
    }
  }
}
JSON
  )
  echo "Wrote minimal config to $CONFIG_JSON"
fi

if [[ "$INSTALL_QUADLET" == true ]]; then
  QUADLET_DIR="$HOME/.config/containers/systemd"
  QUADLET_DST="$QUADLET_DIR/openclaw.container"
  echo "Installing Quadlet to $QUADLET_DST ..."
  mkdir -p "$QUADLET_DIR"
  OPENCLAW_CONFIG_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_CONFIG")"
  OPENCLAW_WORKSPACE_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_WORKSPACE_DIR")"
  OPENCLAW_IMAGE_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_IMAGE")"
  OPENCLAW_CONTAINER_ESCAPED="$(escape_sed_replacement_pipe_delim "$OPENCLAW_CONTAINER_NAME")"
  sed \
    -e "s|{{OPENCLAW_CONFIG_DIR}}|$OPENCLAW_CONFIG_ESCAPED|g" \
    -e "s|{{OPENCLAW_WORKSPACE_DIR}}|$OPENCLAW_WORKSPACE_ESCAPED|g" \
    -e "s|{{IMAGE_NAME}}|$OPENCLAW_IMAGE_ESCAPED|g" \
    -e "s|{{CONTAINER_NAME}}|$OPENCLAW_CONTAINER_ESCAPED|g" \
    "$QUADLET_TEMPLATE" > "$QUADLET_DST"
  chmod 0644 "$QUADLET_DST"

  if command -v systemctl >/dev/null 2>&1; then
    echo "Reloading and enabling user service..."
    if systemctl --user daemon-reload && systemctl --user enable --now openclaw.service; then
      echo "Quadlet installed and service started."
    else
      echo "Quadlet installed, but automatic start failed." >&2
      echo "Try: systemctl --user daemon-reload && systemctl --user start openclaw.service" >&2
      if command -v loginctl >/dev/null 2>&1; then
        echo "For boot persistence on headless hosts: sudo loginctl enable-linger $(whoami)" >&2
      fi
    fi
  else
    echo "systemctl not found; Quadlet installed but not started." >&2
  fi
else
  echo "Container setup complete."
fi

echo
echo "Next:"
echo "  run-openclaw-podman.sh launch"
echo "  run-openclaw-podman.sh launch setup"
echo "  openclaw --container $OPENCLAW_CONTAINER_NAME dashboard --no-open"
