#!/usr/bin/env bash
# Rootless OpenClaw in Podman: run after one-time setup.
#
# One-time setup (from repo root): ./setup-podman.sh
# Then:
#   ./scripts/run-openclaw-podman.sh launch           # Start gateway
#   ./scripts/run-openclaw-podman.sh launch setup      # Onboarding wizard
#
# As the openclaw user (no repo needed):
#   sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
#   sudo -u openclaw /home/openclaw/run-openclaw-podman.sh setup
#
# Legacy: "setup-host" delegates to ../setup-podman.sh

set -euo pipefail

OPENCLAW_USER="${OPENCLAW_PODMAN_USER:-openclaw}"

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

OPENCLAW_HOME="$(resolve_user_home "$OPENCLAW_USER")"
OPENCLAW_UID="$(id -u "$OPENCLAW_USER" 2>/dev/null || true)"
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
  if [[ -n "${OPENCLAW_UID:-}" && "$(id -u)" -ne "$OPENCLAW_UID" ]]; then
    # Exec as openclaw with cwd=/tmp so a nologin user never inherits an invalid cwd.
    exec sudo -u "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" PATH="$PATH" TERM="${TERM:-}" \
      bash -c 'cd /tmp && exec '"$LAUNCH_SCRIPT"' "$@"' _ "$@"
  fi
  # Already openclaw; fall through to container run (with remaining args, e.g. "setup")
fi

# --- Container run (script in openclaw home, run as openclaw) ---
EFFECTIVE_HOME="${HOME:-}"
if [[ -n "${OPENCLAW_UID:-}" && "$(id -u)" -eq "$OPENCLAW_UID" ]]; then
  EFFECTIVE_HOME="$OPENCLAW_HOME"
  export HOME="$OPENCLAW_HOME"
fi
if [[ -z "${EFFECTIVE_HOME:-}" ]]; then
  EFFECTIVE_HOME="${OPENCLAW_HOME:-/tmp}"
fi
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$EFFECTIVE_HOME/.openclaw}"
ENV_FILE="${OPENCLAW_PODMAN_ENV:-$CONFIG_DIR/.env}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$CONFIG_DIR/workspace}"
CONTAINER_NAME="${OPENCLAW_PODMAN_CONTAINER:-openclaw}"
OPENCLAW_IMAGE="${OPENCLAW_PODMAN_IMAGE:-openclaw:local}"
PODMAN_PULL="${OPENCLAW_PODMAN_PULL:-never}"
HOST_GATEWAY_PORT="${OPENCLAW_PODMAN_GATEWAY_HOST_PORT:-${OPENCLAW_GATEWAY_PORT:-18789}}"
HOST_BRIDGE_PORT="${OPENCLAW_PODMAN_BRIDGE_HOST_PORT:-${OPENCLAW_BRIDGE_PORT:-18790}}"
# Keep Podman default local-only unless explicitly overridden.
# Non-loopback binds require gateway.controlUi.allowedOrigins (security hardening).
GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"

# Safe cwd for podman (openclaw is nologin; avoid inherited cwd from sudo)
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
  echo "Missing dependency: need openssl or python3 (or od) to generate OPENCLAW_GATEWAY_TOKEN." >&2
  exit 1
}

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$(generate_token_hex_32)"
  mkdir -p "$(dirname "$ENV_FILE")"
  upsert_env_var "$ENV_FILE" "OPENCLAW_GATEWAY_TOKEN" "$OPENCLAW_GATEWAY_TOKEN"
  echo "Generated OPENCLAW_GATEWAY_TOKEN and wrote it to $ENV_FILE." >&2
fi

# The gateway refuses to start unless gateway.mode=local is set in config.
# Keep this minimal; users can run the wizard later to configure channels/providers.
CONFIG_JSON="$CONFIG_DIR/openclaw.json"
if [[ ! -f "$CONFIG_JSON" ]]; then
  echo '{ gateway: { mode: "local" } }' >"$CONFIG_JSON"
  chmod 600 "$CONFIG_JSON" 2>/dev/null || true
  echo "Created $CONFIG_JSON (minimal gateway.mode=local)." >&2
fi

PODMAN_USERNS="${OPENCLAW_PODMAN_USERNS:-keep-id}"
USERNS_ARGS=()
RUN_USER_ARGS=()
case "$PODMAN_USERNS" in
  ""|auto) ;;
  keep-id) USERNS_ARGS=(--userns=keep-id) ;;
  host) USERNS_ARGS=(--userns=host) ;;
  *)
    echo "Unsupported OPENCLAW_PODMAN_USERNS=$PODMAN_USERNS (expected: keep-id, auto, host)." >&2
    exit 2
    ;;
esac

RUN_UID="$(id -u)"
RUN_GID="$(id -g)"
if [[ "$PODMAN_USERNS" == "keep-id" ]]; then
  RUN_USER_ARGS=(--user "${RUN_UID}:${RUN_GID}")
  echo "Starting container as uid=${RUN_UID} gid=${RUN_GID} (must match owner of $CONFIG_DIR)" >&2
else
  echo "Starting container without --user (OPENCLAW_PODMAN_USERNS=$PODMAN_USERNS), mounts may require ownership fixes." >&2
fi

ENV_FILE_ARGS=()
[[ -f "$ENV_FILE" ]] && ENV_FILE_ARGS+=(--env-file "$ENV_FILE")

if [[ "$RUN_SETUP" == true ]]; then
  exec podman run --pull="$PODMAN_PULL" --rm -it \
    --init \
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
  --init \
  "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
  -e HOME=/home/node -e TERM=xterm-256color \
  -e OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
  "${ENV_FILE_ARGS[@]}" \
  -v "$CONFIG_DIR:/home/node/.openclaw:rw" \
  -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw" \
  -p "${HOST_GATEWAY_PORT}:18789" \
  -p "${HOST_BRIDGE_PORT}:18790" \
  "$OPENCLAW_IMAGE" \
  node dist/index.js gateway --bind "$GATEWAY_BIND" --port 18789

echo "Container $CONTAINER_NAME started. Dashboard: http://127.0.0.1:${HOST_GATEWAY_PORT}/"
echo "Logs: podman logs -f $CONTAINER_NAME"
echo "For auto-start/restarts, use: ./setup-podman.sh --quadlet (Quadlet + systemd user service)."
