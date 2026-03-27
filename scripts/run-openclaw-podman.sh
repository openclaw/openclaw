#!/usr/bin/env bash
# Rootless OpenClaw in Podman: run after one-time setup.
#
# One-time setup (from repo root): ./scripts/podman/setup.sh
# Then:
#   ./scripts/run-openclaw-podman.sh launch           # Start gateway
#   ./scripts/run-openclaw-podman.sh launch setup      # Onboarding wizard
#
# As the openclaw user (no repo needed):
#   sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
#   sudo -u openclaw /home/openclaw/run-openclaw-podman.sh setup
#
# Legacy: "setup-host" delegates to the Podman setup script

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

# Legacy: setup-host → run the Podman setup script
if [[ "${1:-}" == "setup-host" ]]; then
  shift
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  SETUP_PODMAN="$REPO_ROOT/scripts/podman/setup.sh"
  if [[ -f "$SETUP_PODMAN" ]]; then
    exec "$SETUP_PODMAN" "$@"
  fi
  SETUP_PODMAN="$REPO_ROOT/setup-podman.sh"
  if [[ -f "$SETUP_PODMAN" ]]; then
    exec "$SETUP_PODMAN" "$@"
  fi
  echo "Podman setup script not found. Run from repo root: ./scripts/podman/setup.sh" >&2
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

resolve_config_gateway_bind() {
  local config_json="$1"
  if [[ ! -f "$config_json" ]]; then
    return 0
  fi
  python3 - "$config_json" <<'PY' 2>/dev/null || true
import pathlib
import re
import sys

VALID = {"loopback", "lan", "auto", "custom", "tailnet"}
raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="ignore")


def strip_comments(text: str) -> str:
    out = []
    i = 0
    in_string = False
    quote = ""
    escaped = False
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                in_string = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_string = True
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            out.extend("  ")
            i += 2
            while i < len(text) and text[i] not in "\r\n":
                out.append(" ")
                i += 1
            continue
        if ch == "/" and nxt == "*":
            out.extend("  ")
            i += 2
            while i < len(text):
                ch = text[i]
                nxt = text[i + 1] if i + 1 < len(text) else ""
                if ch == "*" and nxt == "/":
                    out.extend("  ")
                    i += 2
                    break
                out.append("\n" if ch == "\n" else ("\r" if ch == "\r" else " "))
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


sanitized = strip_comments(raw)
key_match = re.search(r'["\']?gateway["\']?\s*:\s*\{', sanitized)
if not key_match:
    raise SystemExit(0)

start = sanitized.find("{", key_match.start())
if start < 0:
    raise SystemExit(0)

depth = 0
in_string = False
quote = ""
escaped = False
end = -1
for idx in range(start, len(sanitized)):
    ch = sanitized[idx]
    if in_string:
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == quote:
            in_string = False
    else:
        if ch in ('"', "'"):
            in_string = True
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = idx
                break

if end < 0:
    raise SystemExit(0)

gateway_block = sanitized[start + 1:end]
match = re.search(r'["\']?bind["\']?\s*:\s*["\'](loopback|lan|auto|custom|tailnet)["\']', gateway_block)
if match and match.group(1) in VALID:
    print(match.group(1))
PY
}

# Keep Podman default local-only unless explicitly overridden.
# Non-loopback binds require gateway.controlUi.allowedOrigins (security hardening).
# Precedence: explicit env > openclaw.json gateway.bind > loopback default.
CONFIG_GATEWAY_BIND="$(resolve_config_gateway_bind "$CONFIG_JSON")"
GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-${CONFIG_GATEWAY_BIND:-loopback}}"

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

# On Linux with SELinux enforcing/permissive, add ,Z so Podman relabels the
# bind-mounted directories and the container can access them.
SELINUX_MOUNT_OPTS=""
if [[ -z "${OPENCLAW_BIND_MOUNT_OPTIONS:-}" ]]; then
  if [[ "$(uname -s 2>/dev/null)" == "Linux" ]] && command -v getenforce >/dev/null 2>&1; then
    _selinux_mode="$(getenforce 2>/dev/null || true)"
    if [[ "$_selinux_mode" == "Enforcing" || "$_selinux_mode" == "Permissive" ]]; then
      SELINUX_MOUNT_OPTS=",Z"
    fi
  fi
else
  # Honour explicit override (e.g. OPENCLAW_BIND_MOUNT_OPTIONS=":Z" → strip leading colon for inline use).
  SELINUX_MOUNT_OPTS="${OPENCLAW_BIND_MOUNT_OPTIONS#:}"
  [[ -n "$SELINUX_MOUNT_OPTS" ]] && SELINUX_MOUNT_OPTS=",$SELINUX_MOUNT_OPTS"
fi

if [[ "$RUN_SETUP" == true ]]; then
  exec podman run --pull="$PODMAN_PULL" --rm -it \
    --init \
    "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
    -e HOME=/home/node -e TERM=xterm-256color -e BROWSER=echo \
    -e OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
    -v "$CONFIG_DIR:/home/node/.openclaw:rw${SELINUX_MOUNT_OPTS}" \
    -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw${SELINUX_MOUNT_OPTS}" \
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
  -v "$CONFIG_DIR:/home/node/.openclaw:rw${SELINUX_MOUNT_OPTS}" \
  -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw${SELINUX_MOUNT_OPTS}" \
  -p "${HOST_GATEWAY_PORT}:18789" \
  -p "${HOST_BRIDGE_PORT}:18790" \
  "$OPENCLAW_IMAGE" \
  node dist/index.js gateway --bind "$GATEWAY_BIND" --port 18789

echo "Container $CONTAINER_NAME started. Dashboard: http://127.0.0.1:${HOST_GATEWAY_PORT}/"
echo "Logs: podman logs -f $CONTAINER_NAME"
echo "For auto-start/restarts, use: ./scripts/podman/setup.sh --quadlet (Quadlet + systemd user service)."
