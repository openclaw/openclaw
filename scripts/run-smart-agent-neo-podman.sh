#!/usr/bin/env bash
# Rootless SmartAgentNeo in Podman: run after one-time setup.
#
# One-time setup (from repo root): ./setup-podman.sh
# Then:
#   ./scripts/run-smart-agent-neo-podman.sh launch           # Start gateway
#   ./scripts/run-smart-agent-neo-podman.sh launch setup      # Onboarding wizard
#
# As the smart-agent-neo user (no repo needed):
#   sudo -u smart-agent-neo /home/smart-agent-neo/run-smart-agent-neo-podman.sh
#   sudo -u smart-agent-neo /home/smart-agent-neo/run-smart-agent-neo-podman.sh setup
#
# Legacy: "setup-host" delegates to ../setup-podman.sh

set -euo pipefail

SMART_AGENT_NEO_USER="${SMART_AGENT_NEO_PODMAN_USER:-smart-agent-neo}"

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

SMART_AGENT_NEO_HOME="$(resolve_user_home "$SMART_AGENT_NEO_USER")"
SMART_AGENT_NEO_UID="$(id -u "$SMART_AGENT_NEO_USER" 2>/dev/null || true)"
LAUNCH_SCRIPT="$SMART_AGENT_NEO_HOME/run-smart-agent-neo-podman.sh"

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

# --- Step 2: launch (from repo: re-exec as smart-agent-neo in safe cwd; from smart-agent-neo home: run container) ---
if [[ "${1:-}" == "launch" ]]; then
  shift
  if [[ -n "${SMART_AGENT_NEO_UID:-}" && "$(id -u)" -ne "$SMART_AGENT_NEO_UID" ]]; then
    # Exec as smart-agent-neo with cwd=/tmp so a nologin user never inherits an invalid cwd.
    exec sudo -u "$SMART_AGENT_NEO_USER" env HOME="$SMART_AGENT_NEO_HOME" PATH="$PATH" TERM="${TERM:-}" \
      bash -c 'cd /tmp && exec '"$LAUNCH_SCRIPT"' "$@"' _ "$@"
  fi
  # Already smart-agent-neo; fall through to container run (with remaining args, e.g. "setup")
fi

# --- Container run (script in smart-agent-neo home, run as smart-agent-neo) ---
EFFECTIVE_HOME="${HOME:-}"
if [[ -n "${SMART_AGENT_NEO_UID:-}" && "$(id -u)" -eq "$SMART_AGENT_NEO_UID" ]]; then
  EFFECTIVE_HOME="$SMART_AGENT_NEO_HOME"
  export HOME="$SMART_AGENT_NEO_HOME"
fi
if [[ -z "${EFFECTIVE_HOME:-}" ]]; then
  EFFECTIVE_HOME="${SMART_AGENT_NEO_HOME:-/tmp}"
fi
CONFIG_DIR="${SMART_AGENT_NEO_CONFIG_DIR:-$EFFECTIVE_HOME/.smart-agent-neo}"
ENV_FILE="${SMART_AGENT_NEO_PODMAN_ENV:-$CONFIG_DIR/.env}"
WORKSPACE_DIR="${SMART_AGENT_NEO_WORKSPACE_DIR:-$CONFIG_DIR/workspace}"
CONTAINER_NAME="${SMART_AGENT_NEO_PODMAN_CONTAINER:-smart-agent-neo}"
SMART_AGENT_NEO_IMAGE="${SMART_AGENT_NEO_PODMAN_IMAGE:-smart-agent-neo:local}"
PODMAN_PULL="${SMART_AGENT_NEO_PODMAN_PULL:-never}"
HOST_GATEWAY_PORT="${SMART_AGENT_NEO_PODMAN_GATEWAY_HOST_PORT:-${SMART_AGENT_NEO_GATEWAY_PORT:-18789}}"
HOST_BRIDGE_PORT="${SMART_AGENT_NEO_PODMAN_BRIDGE_HOST_PORT:-${SMART_AGENT_NEO_BRIDGE_PORT:-18790}}"
GATEWAY_BIND="${SMART_AGENT_NEO_GATEWAY_BIND:-lan}"

# Safe cwd for podman (smart-agent-neo is nologin; avoid inherited cwd from sudo)
cd "$EFFECTIVE_HOME" 2>/dev/null || cd /tmp 2>/dev/null || true

RUN_SETUP=false
if [[ "${1:-}" == "setup" || "${1:-}" == "onboard" ]]; then
  RUN_SETUP=true
  shift
fi

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR"
# Subdirs the app may create at runtime (canvas, cron); create here so ownership is correct
mkdir -p "$CONFIG_DIR/canvas" "$CONFIG_DIR/cron"
chmod 700 "$CONFIG_DIR" "$WORKSPACE_DIR" 2>/dev/null || true

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE" 2>/dev/null || true
  set +a
fi

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
  echo "Missing dependency: need openssl or python3 (or od) to generate SMART_AGENT_NEO_GATEWAY_TOKEN." >&2
  exit 1
}

if [[ -z "${SMART_AGENT_NEO_GATEWAY_TOKEN:-}" ]]; then
  export SMART_AGENT_NEO_GATEWAY_TOKEN="$(generate_token_hex_32)"
  mkdir -p "$(dirname "$ENV_FILE")"
  upsert_env_var "$ENV_FILE" "SMART_AGENT_NEO_GATEWAY_TOKEN" "$SMART_AGENT_NEO_GATEWAY_TOKEN"
  echo "Generated SMART_AGENT_NEO_GATEWAY_TOKEN and wrote it to $ENV_FILE." >&2
fi

# The gateway refuses to start unless gateway.mode=local is set in config.
# Keep this minimal; users can run the wizard later to configure channels/providers.
CONFIG_JSON="$CONFIG_DIR/smart-agent-neo.json"
if [[ ! -f "$CONFIG_JSON" ]]; then
  echo '{ gateway: { mode: "local" } }' >"$CONFIG_JSON"
  chmod 600 "$CONFIG_JSON" 2>/dev/null || true
  echo "Created $CONFIG_JSON (minimal gateway.mode=local)." >&2
fi

PODMAN_USERNS="${SMART_AGENT_NEO_PODMAN_USERNS:-keep-id}"
USERNS_ARGS=()
RUN_USER_ARGS=()
case "$PODMAN_USERNS" in
  ""|auto) ;;
  keep-id) USERNS_ARGS=(--userns=keep-id) ;;
  host) USERNS_ARGS=(--userns=host) ;;
  *)
    echo "Unsupported SMART_AGENT_NEO_PODMAN_USERNS=$PODMAN_USERNS (expected: keep-id, auto, host)." >&2
    exit 2
    ;;
esac

RUN_UID="$(id -u)"
RUN_GID="$(id -g)"
if [[ "$PODMAN_USERNS" == "keep-id" ]]; then
  RUN_USER_ARGS=(--user "${RUN_UID}:${RUN_GID}")
  echo "Starting container as uid=${RUN_UID} gid=${RUN_GID} (must match owner of $CONFIG_DIR)" >&2
else
  echo "Starting container without --user (SMART_AGENT_NEO_PODMAN_USERNS=$PODMAN_USERNS), mounts may require ownership fixes." >&2
fi

ENV_FILE_ARGS=()
[[ -f "$ENV_FILE" ]] && ENV_FILE_ARGS+=(--env-file "$ENV_FILE")

if [[ "$RUN_SETUP" == true ]]; then
  exec podman run --pull="$PODMAN_PULL" --rm -it \
    --init \
    "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
    -e HOME=/home/node -e TERM=xterm-256color -e BROWSER=echo \
    -e SMART_AGENT_NEO_GATEWAY_TOKEN="$SMART_AGENT_NEO_GATEWAY_TOKEN" \
    -v "$CONFIG_DIR:/home/node/.smart-agent-neo:rw" \
    -v "$WORKSPACE_DIR:/home/node/.smart-agent-neo/workspace:rw" \
    "${ENV_FILE_ARGS[@]}" \
    "$SMART_AGENT_NEO_IMAGE" \
    node dist/index.js onboard "$@"
fi

podman run --pull="$PODMAN_PULL" -d --replace \
  --name "$CONTAINER_NAME" \
  --init \
  "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
  -e HOME=/home/node -e TERM=xterm-256color \
  -e SMART_AGENT_NEO_GATEWAY_TOKEN="$SMART_AGENT_NEO_GATEWAY_TOKEN" \
  "${ENV_FILE_ARGS[@]}" \
  -v "$CONFIG_DIR:/home/node/.smart-agent-neo:rw" \
  -v "$WORKSPACE_DIR:/home/node/.smart-agent-neo/workspace:rw" \
  -p "${HOST_GATEWAY_PORT}:18789" \
  -p "${HOST_BRIDGE_PORT}:18790" \
  "$SMART_AGENT_NEO_IMAGE" \
  node dist/index.js gateway --bind "$GATEWAY_BIND" --port 18789

echo "Container $CONTAINER_NAME started. Dashboard: http://127.0.0.1:${HOST_GATEWAY_PORT}/"
echo "Logs: podman logs -f $CONTAINER_NAME"
echo "For auto-start/restarts, use: ./setup-podman.sh --quadlet (Quadlet + systemd user service)."
