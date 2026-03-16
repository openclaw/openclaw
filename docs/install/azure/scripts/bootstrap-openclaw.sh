#!/usr/bin/env bash
set -euo pipefail

# Bootstrap OpenClaw host dependencies on Ubuntu.
# Intended for first-run provisioning on the target VM.

OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"
OPENCLAW_INSTALL_CMD="${OPENCLAW_INSTALL_CMD:-npm install -g openclaw@${OPENCLAW_VERSION}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

log() {
  printf '[bootstrap] %s\n' "$*"
}

install_node_24() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "${major}" == "24" ]]; then
      log "Node 24 already installed: $(node -v)"
      return 0
    fi
    log "Node version $(node -v) detected; upgrading to Node 24."
  fi

  log "Installing prerequisites for NodeSource setup."
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg apt-transport-https

  log "Installing Node.js 24.x."
  # Trust model: fetches the official NodeSource setup script over HTTPS.
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  rm -f /tmp/nodesource_setup.sh
  apt-get install -y nodejs
  log "Node installed: $(node -v); npm: $(npm -v)"
}

install_openclaw() {
  log "Installing OpenClaw with: ${OPENCLAW_INSTALL_CMD}"
  bash -lc "${OPENCLAW_INSTALL_CMD}"
  if ! command -v openclaw >/dev/null 2>&1; then
    echo "OpenClaw CLI not found after install command." >&2
    exit 1
  fi
  log "OpenClaw installed: $(openclaw --version || true)"
}

main() {
  install_node_24
  install_openclaw
  log "Bootstrap complete."
}

main "$@"
