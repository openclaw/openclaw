#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# One-time host setup for rootless OpenClaw in Podman. Uses the current
# non-root user throughout, builds or pulls the image into that user's Podman
# store, writes config under ~/.openclaw by default, and uses the repo-local
# launch script at ./scripts/run-openclaw-podman.sh.
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

REPO_PATH="${OPENCLAW_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "$REPO_PATH/scripts/lib/build-metadata.sh"
source "$REPO_PATH/scripts/lib/host-timeout.sh"
source "$REPO_PATH/scripts/lib/container-gateway-capability.sh"
# shellcheck source=scripts/podman/common.sh
source "$REPO_PATH/scripts/podman/common.sh"
RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-openclaw-podman.sh"
QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/openclaw.container.in"
OPENCLAW_USER="$(id -un)"
OPENCLAW_HOME="${HOME:-}"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-}"
OPENCLAW_IMAGE="${OPENCLAW_PODMAN_IMAGE:-${OPENCLAW_IMAGE:-openclaw:local}}"
OPENCLAW_CONTAINER_NAME="${OPENCLAW_PODMAN_CONTAINER:-openclaw}"
PLATFORM_NAME="$(uname -s 2>/dev/null || echo unknown)"
HOST_GATEWAY_PORT="${OPENCLAW_PODMAN_GATEWAY_HOST_PORT:-${OPENCLAW_GATEWAY_PORT:-18789}}"
PODMAN_PULL_TIMEOUT="${OPENCLAW_PODMAN_SETUP_PULL_TIMEOUT:-600s}"
PODMAN_BUILD_TIMEOUT="${OPENCLAW_PODMAN_SETUP_BUILD_TIMEOUT:-1800s}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

is_root() { [[ "$(id -u)" -eq 0 ]]; }

run_podman_pull() {
  local image="$1"
  openclaw_host_timeout_cmd "$PODMAN_PULL_TIMEOUT" podman pull "$image"
}

run_podman_build() {
  openclaw_host_timeout_cmd "$PODMAN_BUILD_TIMEOUT" podman build "$@"
}

validate_container_name() {
  local value="$1"
  validate_single_line_value "container name" "$value"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||
    fail "Invalid container name: $value"
}

validate_image_name() {
  local value="$1"
  validate_single_line_value "image name" "$value"
  case "$value" in
    oci-archive:*|docker-archive:*|dir:*|oci:*|containers-storage:*|docker-daemon:*|archive:* )
      fail "Invalid image name: transport prefixes are not allowed: $value"
      ;;
  esac
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] ||
    fail "Invalid image name: $value"
}

escape_sed_replacement_pipe_delim() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

INSTALL_QUADLET=false
for arg in "$@"; do
  case "$arg" in
    --quadlet) INSTALL_QUADLET=true ;;
    --container) INSTALL_QUADLET=false ;;
  esac
done
if [[ -n "${OPENCLAW_PODMAN_QUADLET:-}" ]]; then
  case "$OPENCLAW_PODMAN_QUADLET" in
    1|[yY][eE][sS]|[tT][rR][uU][eE]) INSTALL_QUADLET=true ;;
    0|[nN][oO]|[fF][aA][lL][sS][eE]) INSTALL_QUADLET=false ;;
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
validate_absolute_path "home directory" "$OPENCLAW_HOME"
validate_mount_source_path "config directory" "$OPENCLAW_CONFIG_DIR"
validate_mount_source_path "workspace directory" "$OPENCLAW_WORKSPACE_DIR"
validate_container_name "$OPENCLAW_CONTAINER_NAME"
validate_image_name "$OPENCLAW_IMAGE"
validate_port "gateway host port" "$HOST_GATEWAY_PORT"

install -d -m 700 "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR"
ensure_private_existing_dir_owned_by_user "config directory" "$OPENCLAW_CONFIG_DIR"
ensure_private_existing_dir_owned_by_user "workspace directory" "$OPENCLAW_WORKSPACE_DIR"

OPENCLAW_IMAGE_APT_PACKAGES="${OPENCLAW_IMAGE_APT_PACKAGES-${OPENCLAW_DOCKER_APT_PACKAGES:-}}"
OPENCLAW_IMAGE_PIP_PACKAGES="${OPENCLAW_IMAGE_PIP_PACKAGES:-}"
BUILD_ARGS=()
BUILD_GIT_COMMIT="$(openclaw_resolve_git_commit "$REPO_PATH")"
BUILD_TIMESTAMP="$(openclaw_resolve_build_timestamp)"
BUILD_ARGS+=(--build-arg "OPENCLAW_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}")
if [[ "$BUILD_GIT_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  BUILD_ARGS+=(--build-arg "GIT_COMMIT=${BUILD_GIT_COMMIT}")
fi
if [[ -n "$OPENCLAW_IMAGE_APT_PACKAGES" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_IMAGE_APT_PACKAGES=${OPENCLAW_IMAGE_APT_PACKAGES}")
fi
if [[ -n "$OPENCLAW_IMAGE_PIP_PACKAGES" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_IMAGE_PIP_PACKAGES=${OPENCLAW_IMAGE_PIP_PACKAGES}")
fi
if [[ -n "${OPENCLAW_EXTENSIONS:-}" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS}")
fi
if [[ -n "${OPENCLAW_INSTALL_BROWSER:-}" ]]; then
  BUILD_ARGS+=(--build-arg "OPENCLAW_INSTALL_BROWSER=${OPENCLAW_INSTALL_BROWSER}")
fi

if [[ "$OPENCLAW_IMAGE" == "openclaw:local" ]]; then
  echo "Building image $OPENCLAW_IMAGE ..."
  run_podman_build -t "$OPENCLAW_IMAGE" -f "$REPO_PATH/Dockerfile" "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" "$REPO_PATH"
else
  if podman image exists "$OPENCLAW_IMAGE" >/dev/null 2>&1; then
    echo "Using existing image $OPENCLAW_IMAGE"
  else
    echo "Pulling image $OPENCLAW_IMAGE ..."
    run_podman_pull "$OPENCLAW_IMAGE"
  fi
fi

openclaw_prepare_gateway_image podman "$OPENCLAW_IMAGE" never >/dev/null

ENV_FILE="$OPENCLAW_CONFIG_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(generate_token_hex_32)"
  (
    umask 077
    write_file_atomically "$ENV_FILE" 600 <<EOF
OPENCLAW_GATEWAY_TOKEN=$TOKEN
EOF
  )
  echo "Generated OPENCLAW_GATEWAY_TOKEN and wrote it to $ENV_FILE"
fi
upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_CONTAINER" "$OPENCLAW_CONTAINER_NAME"
upsert_env_var "$ENV_FILE" "OPENCLAW_PODMAN_IMAGE" "$OPENCLAW_IMAGE"

CONFIG_JSON="$OPENCLAW_CONFIG_DIR/openclaw.json"
if [[ ! -f "$CONFIG_JSON" ]]; then
  (
    umask 077
    write_file_atomically "$CONFIG_JSON" 600 <<'JSON'
{ "gateway": { "mode": "local" } }
JSON
  )
  echo "Wrote minimal config to $CONFIG_JSON"
fi
ensure_local_gateway_mode "$CONFIG_JSON"

if [[ "$INSTALL_QUADLET" == true ]]; then
  QUADLET_DIR="$OPENCLAW_HOME/.config/containers/systemd"
  QUADLET_DST="$QUADLET_DIR/openclaw.container"
  echo "Installing Quadlet to $QUADLET_DST ..."
  mkdir -p "$QUADLET_DIR"
  ensure_safe_existing_dir "quadlet directory" "$QUADLET_DIR"
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
    "$QUADLET_TEMPLATE" | write_file_atomically "$QUADLET_DST" 644

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
  echo "Container setup complete."
fi

echo
echo "Next:"
echo "  ./scripts/run-openclaw-podman.sh launch"
echo "  ./scripts/run-openclaw-podman.sh launch setup"
echo "  openclaw --container $OPENCLAW_CONTAINER_NAME dashboard --no-open"
