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
# Or as the openclaw user: sudo -u openclaw env OPENCLAW_PODMAN_USERNS=keep-id /home/openclaw/run-openclaw-podman.sh
# If you used --quadlet, you can also: sudo systemctl --machine openclaw@ --user start openclaw.service
set -euo pipefail

OPENCLAW_USER="${OPENCLAW_PODMAN_USER:-openclaw}"
REPO_PATH="${OPENCLAW_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-openclaw-podman.sh"
QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/openclaw.container.in"

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

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require_cmd podman
if [[ ! -f "$REPO_PATH/Dockerfile" ]]; then
  echo "Dockerfile not found at $REPO_PATH. Set OPENCLAW_REPO_PATH to the repo root." >&2
  exit 1
fi
if [[ ! -f "$RUN_SCRIPT_SRC" ]]; then
  echo "Launch script not found at $RUN_SCRIPT_SRC." >&2
  exit 1
fi

# Create openclaw user (non-login, with home) if missing
if ! getent passwd "$OPENCLAW_USER" &>/dev/null; then
  echo "Creating user $OPENCLAW_USER (nologin, with home)..."
  sudo useradd -m -s /usr/sbin/nologin "$OPENCLAW_USER"
else
  echo "User $OPENCLAW_USER already exists."
fi

OPENCLAW_HOME="$(getent passwd "$OPENCLAW_USER" | cut -d: -f6)"
OPENCLAW_CONFIG="$OPENCLAW_HOME/.openclaw"
LAUNCH_SCRIPT_DST="$OPENCLAW_HOME/run-openclaw-podman.sh"

# Rootless Podman needs subuid/subgid for the run user
if ! grep -q "^${OPENCLAW_USER}:" /etc/subuid 2>/dev/null; then
  echo "Warning: $OPENCLAW_USER has no subuid range. Rootless Podman may fail." >&2
  echo "  Add a line to /etc/subuid and /etc/subgid, e.g.: $OPENCLAW_USER:100000:65536" >&2
fi

echo "Creating $OPENCLAW_CONFIG and workspace..."
sudo mkdir -p "$OPENCLAW_CONFIG/workspace"
sudo chown -R "$OPENCLAW_USER:" "$OPENCLAW_CONFIG"

if [[ ! -f "$OPENCLAW_CONFIG/.env" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 32)"
  else
    TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
  echo "OPENCLAW_GATEWAY_TOKEN=$TOKEN" | sudo tee "$OPENCLAW_CONFIG/.env" >/dev/null
  sudo chown "$OPENCLAW_USER:" "$OPENCLAW_CONFIG/.env"
  echo "Created $OPENCLAW_CONFIG/.env with new token."
fi

echo "Building image from $REPO_PATH..."
podman build -t openclaw:local -f "$REPO_PATH/Dockerfile" "$REPO_PATH"

echo "Loading image into $OPENCLAW_USER's Podman store..."
TMP_IMAGE="$(mktemp -p /tmp openclaw-image.XXXXXX.tar)"
trap 'rm -f "$TMP_IMAGE"' EXIT
podman save openclaw:local -o "$TMP_IMAGE"
chmod 644 "$TMP_IMAGE"
(cd /tmp && sudo -u "$OPENCLAW_USER" podman load -i "$TMP_IMAGE")
rm -f "$TMP_IMAGE"
trap - EXIT

echo "Copying launch script to $LAUNCH_SCRIPT_DST..."
sudo cp "$RUN_SCRIPT_SRC" "$LAUNCH_SCRIPT_DST"
sudo chown "$OPENCLAW_USER:" "$LAUNCH_SCRIPT_DST"
sudo chmod 755 "$LAUNCH_SCRIPT_DST"

if command -v loginctl &>/dev/null; then
  sudo loginctl enable-linger "$OPENCLAW_USER" 2>/dev/null || true
fi

# Optionally install systemd quadlet for openclaw user (rootless Podman + systemd)
QUADLET_DIR="$OPENCLAW_HOME/.config/containers/systemd"
if [[ "$INSTALL_QUADLET" == true && -f "$QUADLET_TEMPLATE" ]]; then
  echo "Installing systemd quadlet for $OPENCLAW_USER..."
  sudo mkdir -p "$QUADLET_DIR"
  sed "s|{{OPENCLAW_HOME}}|$OPENCLAW_HOME|g" "$QUADLET_TEMPLATE" | sudo tee "$QUADLET_DIR/openclaw.container" >/dev/null
  sudo chown -R "$OPENCLAW_USER:" "$QUADLET_DIR"
  if command -v systemctl &>/dev/null; then
    sudo systemctl --machine "${OPENCLAW_USER}@" --user daemon-reload 2>/dev/null || true
    sudo systemctl --machine "${OPENCLAW_USER}@" --user enable openclaw.service 2>/dev/null || true
    sudo systemctl --machine "${OPENCLAW_USER}@" --user start openclaw.service 2>/dev/null || true
  fi
fi

echo ""
echo "Setup complete. Start the gateway:"
echo "  $RUN_SCRIPT_SRC launch"
echo "  $RUN_SCRIPT_SRC launch setup   # onboarding wizard"
echo "Or as $OPENCLAW_USER (e.g. from cron):"
echo "  sudo -u $OPENCLAW_USER env OPENCLAW_PODMAN_USERNS=keep-id $LAUNCH_SCRIPT_DST"
echo "  sudo -u $OPENCLAW_USER env OPENCLAW_PODMAN_USERNS=keep-id $LAUNCH_SCRIPT_DST setup"
if [[ "$INSTALL_QUADLET" == true ]]; then
  echo "Or use systemd (quadlet):"
  echo "  sudo systemctl --machine ${OPENCLAW_USER}@ --user start openclaw.service"
  echo "  sudo systemctl --machine ${OPENCLAW_USER}@ --user status openclaw.service"
else
  echo "To install systemd quadlet later: $0 --quadlet"
fi
