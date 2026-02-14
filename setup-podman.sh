#!/usr/bin/env bash
# One-time host setup for rootless OpenClaw in Podman: creates the openclaw
# user, builds the image, loads it into that user's Podman store, and installs
# the launch script. Run from repo root with sudo capability.
#
# Usage: ./setup-podman.sh [--quadlet|--container]
#   --quadlet   Install systemd Quadlet so the container runs as a user service
#   --container Only install user + image + launch script; you start the container manually (default)
#   Or set OPENCLAW_PODMAN_QUADLET=1 (or 0) to choose without a flag.
#
# After this, start the gateway manually:
#   ./scripts/run-openclaw-podman.sh launch
#   ./scripts/run-openclaw-podman.sh launch setup   # onboarding wizard
# Or as the openclaw user: sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
# If you used --quadlet, you can also: sudo systemctl --machine openclaw@ --user start openclaw.service
set -euo pipefail

OPENCLAW_USER="${OPENCLAW_PODMAN_USER:-openclaw}"
REPO_PATH="${OPENCLAW_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-openclaw-podman.sh"
QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/openclaw.container.in"

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

require_cmd podman
if ! is_root; then
  require_cmd sudo
fi
if [[ ! -f "$REPO_PATH/Dockerfile" ]]; then
  echo "Dockerfile not found at $REPO_PATH. Set OPENCLAW_REPO_PATH to the repo root." >&2
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
  echo "Missing dependency: need openssl or python3 (or od) to generate OPENCLAW_GATEWAY_TOKEN." >&2
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

# Create openclaw user (non-login, with home) if missing
if ! user_exists "$OPENCLAW_USER"; then
  NOLOGIN_SHELL="$(resolve_nologin_shell)"
  echo "Creating user $OPENCLAW_USER ($NOLOGIN_SHELL, with home)..."
  if command -v useradd >/dev/null 2>&1; then
    run_root useradd -m -s "$NOLOGIN_SHELL" "$OPENCLAW_USER"
  elif command -v adduser >/dev/null 2>&1; then
    # Debian/Ubuntu: adduser supports --disabled-password/--gecos. Busybox adduser differs.
    run_root adduser --disabled-password --gecos "" --shell "$NOLOGIN_SHELL" "$OPENCLAW_USER"
  else
    echo "Neither useradd nor adduser found, cannot create user $OPENCLAW_USER." >&2
    exit 1
  fi
else
  echo "User $OPENCLAW_USER already exists."
fi

OPENCLAW_HOME="$(resolve_user_home "$OPENCLAW_USER")"
OPENCLAW_UID="$(id -u "$OPENCLAW_USER" 2>/dev/null || true)"
OPENCLAW_CONFIG="$OPENCLAW_HOME/.openclaw"
LAUNCH_SCRIPT_DST="$OPENCLAW_HOME/run-openclaw-podman.sh"

# Prefer systemd user services (Quadlet) for production. Enable lingering early so rootless Podman can run
# without an interactive login.
if command -v loginctl &>/dev/null; then
  run_root loginctl enable-linger "$OPENCLAW_USER" 2>/dev/null || true
fi
if [[ -n "${OPENCLAW_UID:-}" && -d /run/user ]] && command -v systemctl &>/dev/null; then
  run_root systemctl start "user@${OPENCLAW_UID}.service" 2>/dev/null || true
fi

# Rootless Podman needs subuid/subgid for the run user
if ! grep -q "^${OPENCLAW_USER}:" /etc/subuid 2>/dev/null; then
  echo "Warning: $OPENCLAW_USER has no subuid range. Rootless Podman may fail." >&2
  echo "  Add a line to /etc/subuid and /etc/subgid, e.g.: $OPENCLAW_USER:100000:65536" >&2
fi

echo "Creating $OPENCLAW_CONFIG and workspace..."
run_root mkdir -p "$OPENCLAW_CONFIG/workspace"
run_root chown -R "$OPENCLAW_USER:" "$OPENCLAW_CONFIG"
run_root chmod 700 "$OPENCLAW_CONFIG" "$OPENCLAW_CONFIG/workspace" 2>/dev/null || true

ENV_FILE="$OPENCLAW_CONFIG/.env"
if [[ -f "$ENV_FILE" ]]; then
  if ! grep -q '^OPENCLAW_GATEWAY_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    TOKEN="$(generate_token_hex_32)"
    echo "OPENCLAW_GATEWAY_TOKEN=$TOKEN" | run_root tee -a "$ENV_FILE" >/dev/null
    echo "Added OPENCLAW_GATEWAY_TOKEN to $ENV_FILE."
  fi
  run_root chown "$OPENCLAW_USER:" "$ENV_FILE"
  run_root chmod 600 "$ENV_FILE" 2>/dev/null || true
else
  TOKEN="$(generate_token_hex_32)"
  echo "OPENCLAW_GATEWAY_TOKEN=$TOKEN" | run_root tee "$ENV_FILE" >/dev/null
  run_root chown "$OPENCLAW_USER:" "$ENV_FILE"
  run_root chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo "Created $ENV_FILE with new token."
fi

# The gateway refuses to start unless gateway.mode=local is set in config.
# Make first-run non-interactive; users can run the wizard later to configure channels/providers.
OPENCLAW_JSON="$OPENCLAW_CONFIG/openclaw.json"
if [[ ! -f "$OPENCLAW_JSON" ]]; then
  echo '{ gateway: { mode: "local" } }' | run_root tee "$OPENCLAW_JSON" >/dev/null
  run_root chown "$OPENCLAW_USER:" "$OPENCLAW_JSON"
  run_root chmod 600 "$OPENCLAW_JSON" 2>/dev/null || true
  echo "Created $OPENCLAW_JSON (minimal gateway.mode=local)."
fi

echo "Building image from $REPO_PATH..."
podman build -t openclaw:local -f "$REPO_PATH/Dockerfile" "$REPO_PATH"

echo "Loading image into $OPENCLAW_USER's Podman store..."
TMP_IMAGE="$(mktemp -p /tmp openclaw-image.XXXXXX.tar)"
trap 'rm -f "$TMP_IMAGE"' EXIT
podman save openclaw:local -o "$TMP_IMAGE"
chmod 644 "$TMP_IMAGE"
(cd /tmp && run_as_user "$OPENCLAW_USER" env HOME="$OPENCLAW_HOME" podman load -i "$TMP_IMAGE")
rm -f "$TMP_IMAGE"
trap - EXIT

echo "Copying launch script to $LAUNCH_SCRIPT_DST..."
run_root cp "$RUN_SCRIPT_SRC" "$LAUNCH_SCRIPT_DST"
run_root chown "$OPENCLAW_USER:" "$LAUNCH_SCRIPT_DST"
run_root chmod 755 "$LAUNCH_SCRIPT_DST"

# Optionally install systemd quadlet for openclaw user (rootless Podman + systemd)
QUADLET_DIR="$OPENCLAW_HOME/.config/containers/systemd"
if [[ "$INSTALL_QUADLET" == true && -f "$QUADLET_TEMPLATE" ]]; then
  echo "Installing systemd quadlet for $OPENCLAW_USER..."
  run_root mkdir -p "$QUADLET_DIR"
  sed "s|{{OPENCLAW_HOME}}|$OPENCLAW_HOME|g" "$QUADLET_TEMPLATE" | run_root tee "$QUADLET_DIR/openclaw.container" >/dev/null
  run_root chown -R "$OPENCLAW_USER:" "$QUADLET_DIR"
  if command -v systemctl &>/dev/null; then
    run_root systemctl --machine "${OPENCLAW_USER}@" --user daemon-reload 2>/dev/null || true
    run_root systemctl --machine "${OPENCLAW_USER}@" --user enable openclaw.service 2>/dev/null || true
    run_root systemctl --machine "${OPENCLAW_USER}@" --user start openclaw.service 2>/dev/null || true
  fi
fi

echo ""
echo "Setup complete. Start the gateway:"
echo "  $RUN_SCRIPT_SRC launch"
echo "  $RUN_SCRIPT_SRC launch setup   # onboarding wizard"
echo "Or as $OPENCLAW_USER (e.g. from cron):"
echo "  sudo -u $OPENCLAW_USER $LAUNCH_SCRIPT_DST"
echo "  sudo -u $OPENCLAW_USER $LAUNCH_SCRIPT_DST setup"
if [[ "$INSTALL_QUADLET" == true ]]; then
  echo "Or use systemd (quadlet):"
  echo "  sudo systemctl --machine ${OPENCLAW_USER}@ --user start openclaw.service"
  echo "  sudo systemctl --machine ${OPENCLAW_USER}@ --user status openclaw.service"
else
  echo "To install systemd quadlet later: $0 --quadlet"
fi
