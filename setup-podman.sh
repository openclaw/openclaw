#!/usr/bin/env bash
# One-time host setup for rootless SmartAgentNeo in Podman: creates the smart-agent-neo
# user, builds the image, loads it into that user's Podman store, and installs
# the launch script. Run from repo root with sudo capability.
#
# Usage: ./setup-podman.sh [--quadlet|--container]
#   --quadlet   Install systemd Quadlet so the container runs as a user service
#   --container Only install user + image + launch script; you start the container manually (default)
#   Or set SMART_AGENT_NEO_PODMAN_QUADLET=1 (or 0) to choose without a flag.
#
# After this, start the gateway manually:
#   ./scripts/run-smart-agent-neo-podman.sh launch
#   ./scripts/run-smart-agent-neo-podman.sh launch setup   # onboarding wizard
# Or as the smart-agent-neo user: sudo -u smart-agent-neo /home/smart-agent-neo/run-smart-agent-neo-podman.sh
# If you used --quadlet, you can also: sudo systemctl --machine smart-agent-neo@ --user start smart-agent-neo.service
set -euo pipefail

SMART_AGENT_NEO_USER="${SMART_AGENT_NEO_PODMAN_USER:-smart-agent-neo}"
REPO_PATH="${SMART_AGENT_NEO_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-smart-agent-neo-podman.sh"
QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/smart-agent-neo.container.in"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

is_root() { [[ "$(id -u)" -eq 0 ]]; }

run_root() {
  if is_root; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_user() {
  local user="$1"
  shift
  if command -v sudo >/dev/null 2>&1; then
    sudo -u "$user" "$@"
  elif is_root && command -v runuser >/dev/null 2>&1; then
    runuser -u "$user" -- "$@"
  else
    echo "Need sudo (or root+runuser) to run commands as $user." >&2
    exit 1
  fi
}

run_as_smart-agent-neo() {
  # Avoid root writes into $SMART_AGENT_NEO_HOME (symlink/hardlink/TOCTOU footguns).
  # Anything under the target user's home should be created/modified as that user.
  run_as_user "$SMART_AGENT_NEO_USER" env HOME="$SMART_AGENT_NEO_HOME" "$@"
}

# Quadlet: opt-in via --quadlet or SMART_AGENT_NEO_PODMAN_QUADLET=1
INSTALL_QUADLET=false
for arg in "$@"; do
  case "$arg" in
    --quadlet)   INSTALL_QUADLET=true ;;
    --container) INSTALL_QUADLET=false ;;
  esac
done
if [[ -n "${SMART_AGENT_NEO_PODMAN_QUADLET:-}" ]]; then
  case "${SMART_AGENT_NEO_PODMAN_QUADLET,,}" in
    1|yes|true)  INSTALL_QUADLET=true ;;
    0|no|false) INSTALL_QUADLET=false ;;
  esac
fi

require_cmd podman
if ! is_root; then
  require_cmd sudo
fi
if [[ ! -f "$REPO_PATH/Dockerfile" ]]; then
  echo "Dockerfile not found at $REPO_PATH. Set SMART_AGENT_NEO_REPO_PATH to the repo root." >&2
  exit 1
fi
if [[ ! -f "$RUN_SCRIPT_SRC" ]]; then
  echo "Launch script not found at $RUN_SCRIPT_SRC." >&2
  exit 1
fi

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
    # 32 random bytes -> 64 lowercase hex chars
    od -An -N32 -tx1 /dev/urandom | tr -d " \n"
    return 0
  fi
  echo "Missing dependency: need openssl or python3 (or od) to generate SMART_AGENT_NEO_GATEWAY_TOKEN." >&2
  exit 1
}

user_exists() {
  local user="$1"
  if command -v getent >/dev/null 2>&1; then
    getent passwd "$user" >/dev/null 2>&1 && return 0
  fi
  id -u "$user" >/dev/null 2>&1
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

resolve_nologin_shell() {
  for cand in /usr/sbin/nologin /sbin/nologin /usr/bin/nologin /bin/false; do
    if [[ -x "$cand" ]]; then
      printf '%s' "$cand"
      return 0
    fi
  done
  printf '%s' "/usr/sbin/nologin"
}

# Create smart-agent-neo user (non-login, with home) if missing
if ! user_exists "$SMART_AGENT_NEO_USER"; then
  NOLOGIN_SHELL="$(resolve_nologin_shell)"
  echo "Creating user $SMART_AGENT_NEO_USER ($NOLOGIN_SHELL, with home)..."
  if command -v useradd >/dev/null 2>&1; then
    run_root useradd -m -s "$NOLOGIN_SHELL" "$SMART_AGENT_NEO_USER"
  elif command -v adduser >/dev/null 2>&1; then
    # Debian/Ubuntu: adduser supports --disabled-password/--gecos. Busybox adduser differs.
    run_root adduser --disabled-password --gecos "" --shell "$NOLOGIN_SHELL" "$SMART_AGENT_NEO_USER"
  else
    echo "Neither useradd nor adduser found, cannot create user $SMART_AGENT_NEO_USER." >&2
    exit 1
  fi
else
  echo "User $SMART_AGENT_NEO_USER already exists."
fi

SMART_AGENT_NEO_HOME="$(resolve_user_home "$SMART_AGENT_NEO_USER")"
SMART_AGENT_NEO_UID="$(id -u "$SMART_AGENT_NEO_USER" 2>/dev/null || true)"
SMART_AGENT_NEO_CONFIG="$SMART_AGENT_NEO_HOME/.smart-agent-neo"
LAUNCH_SCRIPT_DST="$SMART_AGENT_NEO_HOME/run-smart-agent-neo-podman.sh"

# Prefer systemd user services (Quadlet) for production. Enable lingering early so rootless Podman can run
# without an interactive login.
if command -v loginctl &>/dev/null; then
  run_root loginctl enable-linger "$SMART_AGENT_NEO_USER" 2>/dev/null || true
fi
if [[ -n "${SMART_AGENT_NEO_UID:-}" && -d /run/user ]] && command -v systemctl &>/dev/null; then
  run_root systemctl start "user@${SMART_AGENT_NEO_UID}.service" 2>/dev/null || true
fi

# Rootless Podman needs subuid/subgid for the run user
if ! grep -q "^${SMART_AGENT_NEO_USER}:" /etc/subuid 2>/dev/null; then
  echo "Warning: $SMART_AGENT_NEO_USER has no subuid range. Rootless Podman may fail." >&2
  echo "  Add a line to /etc/subuid and /etc/subgid, e.g.: $SMART_AGENT_NEO_USER:100000:65536" >&2
fi

echo "Creating $SMART_AGENT_NEO_CONFIG and workspace..."
run_as_smart-agent-neo mkdir -p "$SMART_AGENT_NEO_CONFIG/workspace"
run_as_smart-agent-neo chmod 700 "$SMART_AGENT_NEO_CONFIG" "$SMART_AGENT_NEO_CONFIG/workspace" 2>/dev/null || true

ENV_FILE="$SMART_AGENT_NEO_CONFIG/.env"
if run_as_smart-agent-neo test -f "$ENV_FILE"; then
  if ! run_as_smart-agent-neo grep -q '^SMART_AGENT_NEO_GATEWAY_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    TOKEN="$(generate_token_hex_32)"
    printf 'SMART_AGENT_NEO_GATEWAY_TOKEN=%s\n' "$TOKEN" | run_as_smart-agent-neo tee -a "$ENV_FILE" >/dev/null
    echo "Added SMART_AGENT_NEO_GATEWAY_TOKEN to $ENV_FILE."
  fi
  run_as_smart-agent-neo chmod 600 "$ENV_FILE" 2>/dev/null || true
else
  TOKEN="$(generate_token_hex_32)"
  printf 'SMART_AGENT_NEO_GATEWAY_TOKEN=%s\n' "$TOKEN" | run_as_smart-agent-neo tee "$ENV_FILE" >/dev/null
  run_as_smart-agent-neo chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo "Created $ENV_FILE with new token."
fi

# The gateway refuses to start unless gateway.mode=local is set in config.
# Make first-run non-interactive; users can run the wizard later to configure channels/providers.
SMART_AGENT_NEO_JSON="$SMART_AGENT_NEO_CONFIG/smart-agent-neo.json"
if ! run_as_smart-agent-neo test -f "$SMART_AGENT_NEO_JSON"; then
  printf '%s\n' '{ gateway: { mode: "local" } }' | run_as_smart-agent-neo tee "$SMART_AGENT_NEO_JSON" >/dev/null
  run_as_smart-agent-neo chmod 600 "$SMART_AGENT_NEO_JSON" 2>/dev/null || true
  echo "Created $SMART_AGENT_NEO_JSON (minimal gateway.mode=local)."
fi

echo "Building image from $REPO_PATH..."
podman build -t smart-agent-neo:local -f "$REPO_PATH/Dockerfile" "$REPO_PATH"

echo "Loading image into $SMART_AGENT_NEO_USER's Podman store..."
TMP_IMAGE="$(mktemp -p /tmp smart-agent-neo-image.XXXXXX.tar)"
trap 'rm -f "$TMP_IMAGE"' EXIT
podman save smart-agent-neo:local -o "$TMP_IMAGE"
chmod 644 "$TMP_IMAGE"
(cd /tmp && run_as_user "$SMART_AGENT_NEO_USER" env HOME="$SMART_AGENT_NEO_HOME" podman load -i "$TMP_IMAGE")
rm -f "$TMP_IMAGE"
trap - EXIT

echo "Copying launch script to $LAUNCH_SCRIPT_DST..."
run_root cat "$RUN_SCRIPT_SRC" | run_as_smart-agent-neo tee "$LAUNCH_SCRIPT_DST" >/dev/null
run_as_smart-agent-neo chmod 755 "$LAUNCH_SCRIPT_DST"

# Optionally install systemd quadlet for smart-agent-neo user (rootless Podman + systemd)
QUADLET_DIR="$SMART_AGENT_NEO_HOME/.config/containers/systemd"
if [[ "$INSTALL_QUADLET" == true && -f "$QUADLET_TEMPLATE" ]]; then
  echo "Installing systemd quadlet for $SMART_AGENT_NEO_USER..."
  run_as_smart-agent-neo mkdir -p "$QUADLET_DIR"
  SMART_AGENT_NEO_HOME_SED="$(printf '%s' "$SMART_AGENT_NEO_HOME" | sed -e 's/[\\/&|]/\\\\&/g')"
  sed "s|{{SMART_AGENT_NEO_HOME}}|$SMART_AGENT_NEO_HOME_SED|g" "$QUADLET_TEMPLATE" | run_as_smart-agent-neo tee "$QUADLET_DIR/smart-agent-neo.container" >/dev/null
  run_as_smart-agent-neo chmod 700 "$SMART_AGENT_NEO_HOME/.config" "$SMART_AGENT_NEO_HOME/.config/containers" "$QUADLET_DIR" 2>/dev/null || true
  run_as_smart-agent-neo chmod 600 "$QUADLET_DIR/smart-agent-neo.container" 2>/dev/null || true
  if command -v systemctl &>/dev/null; then
    run_root systemctl --machine "${SMART_AGENT_NEO_USER}@" --user daemon-reload 2>/dev/null || true
    run_root systemctl --machine "${SMART_AGENT_NEO_USER}@" --user enable smart-agent-neo.service 2>/dev/null || true
    run_root systemctl --machine "${SMART_AGENT_NEO_USER}@" --user start smart-agent-neo.service 2>/dev/null || true
  fi
fi

echo ""
echo "Setup complete. Start the gateway:"
echo "  $RUN_SCRIPT_SRC launch"
echo "  $RUN_SCRIPT_SRC launch setup   # onboarding wizard"
echo "Or as $SMART_AGENT_NEO_USER (e.g. from cron):"
echo "  sudo -u $SMART_AGENT_NEO_USER $LAUNCH_SCRIPT_DST"
echo "  sudo -u $SMART_AGENT_NEO_USER $LAUNCH_SCRIPT_DST setup"
if [[ "$INSTALL_QUADLET" == true ]]; then
  echo "Or use systemd (quadlet):"
  echo "  sudo systemctl --machine ${SMART_AGENT_NEO_USER}@ --user start smart-agent-neo.service"
  echo "  sudo systemctl --machine ${SMART_AGENT_NEO_USER}@ --user status smart-agent-neo.service"
else
  echo "To install systemd quadlet later: $0 --quadlet"
fi
