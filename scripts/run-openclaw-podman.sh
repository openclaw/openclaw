#!/usr/bin/env bash
# Rootless OpenClaw in Podman: run after one-time setup.
#
# One-time setup (from repo root): ./setup-podman.sh
# Then:
#   ./scripts/run-openclaw-podman.sh launch           # Start gateway
#   ./scripts/run-openclaw-podman.sh launch setup      # Onboarding wizard
#
# As the openclaw user (no repo needed):
#   sudo -u openclaw env OPENCLAW_PODMAN_USERNS=keep-id /home/openclaw/run-openclaw-podman.sh
#   sudo -u openclaw env OPENCLAW_PODMAN_USERNS=keep-id /home/openclaw/run-openclaw-podman.sh setup
#
# Legacy: "setup-host" delegates to ../setup-podman.sh

set -euo pipefail

OPENCLAW_USER="${OPENCLAW_PODMAN_USER:-openclaw}"
OPENCLAW_HOME="$(getent passwd "$OPENCLAW_USER" 2>/dev/null | cut -d: -f6)"
OPENCLAW_HOME="${OPENCLAW_HOME:-/home/$OPENCLAW_USER}"
LAUNCH_SCRIPT="$OPENCLAW_HOME/run-openclaw-podman.sh"

# Legacy: setup-host → run setup-podman.sh
if [[ "${1:-}" == "setup-host" ]]; then
  shift
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  SETUP_PODMAN="$REPO_ROOT/setup-podman.sh"
  if [[ -f "$SETUP_PODMAN" ]]; then
    exec "$SETUP_PODMAN" "$@"
  fi
  echo "setup-podman.sh not found at $SETUP_PODMAN. Run from repo root: ./setup-podman.sh" >&2
  exit 1
fi

# --- Step 2: launch (from repo: re-exec as openclaw in safe cwd; from openclaw home: run container) ---
if [[ "${1:-}" == "launch" ]]; then
  shift
  if [[ "$(id -u)" -ne $(id -u "$OPENCLAW_USER" 2>/dev/null || echo -1) ]]; then
    # Run from repo: exec as openclaw with cwd=/tmp so nologin user has valid cwd
    exec env -i HOME="$OPENCLAW_HOME" PATH="$PATH" TERM="${TERM:-}" \
      bash -c 'cd /tmp && exec sudo -u '"$OPENCLAW_USER"' env OPENCLAW_PODMAN_USERNS=keep-id '"$LAUNCH_SCRIPT"' "$@"' _ "$@"
  fi
  # Already openclaw; fall through to container run (with remaining args, e.g. "setup")
fi

# --- Container run (script in openclaw home, run as openclaw) ---
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
ENV_FILE="${OPENCLAW_PODMAN_ENV:-$CONFIG_DIR/.env}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$CONFIG_DIR/workspace}"
CONTAINER_NAME="${OPENCLAW_PODMAN_CONTAINER:-openclaw}"
OPENCLAW_IMAGE="${OPENCLAW_PODMAN_IMAGE:-openclaw:local}"
PODMAN_PULL="${OPENCLAW_PODMAN_PULL:-never}"

# Safe cwd for podman (openclaw is nologin; avoid inherited cwd from sudo)
cd "$HOME" 2>/dev/null || cd /tmp 2>/dev/null || true

RUN_SETUP=false
if [[ "${1:-}" == "setup" || "${1:-}" == "onboard" ]]; then
  RUN_SETUP=true
  shift
fi

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR"
# Subdirs the app may create at runtime (canvas, cron); create here so ownership is correct
mkdir -p "$CONFIG_DIR/canvas" "$CONFIG_DIR/cron"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE" 2>/dev/null || true
  set +a
fi

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl &>/dev/null; then
    export OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    export OPENCLAW_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
  echo "Generated OPENCLAW_GATEWAY_TOKEN; add it to $ENV_FILE to reuse."
fi

PODMAN_USERNS="${OPENCLAW_PODMAN_USERNS:-keep-id}"
USERNS_ARGS=(--userns=keep-id)
RUN_UID="$(id -u)"
RUN_GID="$(id -g)"
RUN_USER_ARGS=(--user "${RUN_UID}:${RUN_GID}")
echo "Starting container as uid=${RUN_UID} gid=${RUN_GID} (must match owner of $CONFIG_DIR)" >&2

ENV_FILE_ARGS=()
[[ -f "$ENV_FILE" ]] && ENV_FILE_ARGS+=(--env-file "$ENV_FILE")

if [[ "$RUN_SETUP" == true ]]; then
  exec podman run --pull="$PODMAN_PULL" --rm -it \
    "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
    -e HOME=/home/node -e TERM=xterm-256color -e BROWSER=echo \
    -e OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
    -v "$CONFIG_DIR:/home/node/.openclaw:rw" \
    -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw" \
    "${ENV_FILE_ARGS[@]}" \
    "$OPENCLAW_IMAGE" \
    node dist/index.js onboard "$@"
fi

podman run --pull="$PODMAN_PULL" -d --replace \
  --name "$CONTAINER_NAME" \
  "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
  --restart=unless-stopped \
  -e HOME=/home/node -e TERM=xterm-256color \
  -e OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
  -e OPENCLAW_CONFIG_DIR="$CONFIG_DIR" \
  -e OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR" \
  -e OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}" \
  -e OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}" \
  -e OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}" \
  "${ENV_FILE_ARGS[@]}" \
  -v "$CONFIG_DIR:/home/node/.openclaw:rw" \
  -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw" \
  -p "${OPENCLAW_GATEWAY_PORT:-18789}:18789" \
  -p "${OPENCLAW_BRIDGE_PORT:-18790}:18790" \
  "$OPENCLAW_IMAGE" \
  node dist/index.js gateway --bind "${OPENCLAW_GATEWAY_BIND:-lan}" --port 18789

echo "Container $CONTAINER_NAME started. Dashboard: http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/"
echo "Logs: podman logs -f $CONTAINER_NAME"
