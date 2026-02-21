#!/usr/bin/env bash
# Build the javis-fork TypeScript gateway, install it globally, and restart the gateway service.
# Usage: scripts/install-javis-fork.sh [--skip-build]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_PATH="${OPENCLAW_INSTALL_LOG:-/tmp/openclaw-install-javis-fork.log}"
GATEWAY_LABEL="ai.openclaw.gateway"
GATEWAY_PLIST="${HOME}/Library/LaunchAgents/${GATEWAY_LABEL}.plist"
SKIP_BUILD="${1:-}"

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

run_step() {
  local label="$1"; shift
  log "==> ${label}"
  if ! "$@"; then
    fail "${label} failed"
  fi
}

mkdir -p "$(dirname "${LOG_PATH}")"
exec > >(tee "${LOG_PATH}") 2>&1
log "==> Log: ${LOG_PATH}"
log "==> Root: ${ROOT_DIR}"
log "==> Branch: $(cd "${ROOT_DIR}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

export PATH="${ROOT_DIR}/node_modules/.bin:${PATH}"

if [[ "${SKIP_BUILD}" != "--skip-build" ]]; then
  # Install node dependencies if needed.
  if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
    run_step "install node dependencies" bash -lc "cd '${ROOT_DIR}' && pnpm install --frozen-lockfile"
  fi

  # Build the TypeScript gateway bundle.
  run_step "build TypeScript gateway" bash -lc "cd '${ROOT_DIR}' && pnpm build"
else
  log "==> (skipping build — using existing dist/)"
fi

# Install globally from the local fork directory.
run_step "npm install -g (javis fork)" bash -lc "cd '${ROOT_DIR}' && npm install -g ."

# Confirm installed binary.
INSTALLED_BIN="$(command -v openclaw 2>/dev/null || true)"
[[ -z "${INSTALLED_BIN}" ]] && fail "openclaw binary not found in PATH after install"
INSTALLED_VERSION="$(openclaw --version 2>/dev/null || echo unknown)"
log "==> Installed: ${INSTALLED_BIN}  (${INSTALLED_VERSION})"

# Restart the gateway LaunchAgent.
if launchctl list "${GATEWAY_LABEL}" >/dev/null 2>&1; then
  run_step "stop gateway" launchctl bootout "gui/${UID}/${GATEWAY_LABEL}" 2>/dev/null || true
  sleep 0.5
fi

if [[ -f "${GATEWAY_PLIST}" ]]; then
  run_step "start gateway" launchctl load -w "${GATEWAY_PLIST}"
  sleep 1.5
  launchctl list "${GATEWAY_LABEL}" >/dev/null 2>&1 \
    && log "==> Gateway is running (label: ${GATEWAY_LABEL})" \
    || fail "Gateway failed to start. Check: ${HOME}/.openclaw/logs/gateway.err.log"
else
  log "==> WARNING: Gateway plist not found at ${GATEWAY_PLIST}"
  log "    Run: openclaw gateway install  then re-run this script"
fi

PKG_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version" 2>/dev/null || echo unknown)"
GIT_COMMIT="$(cd "${ROOT_DIR}" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log ""
log "==> Install complete."
log "    package version : ${PKG_VERSION}"
log "    git commit      : ${GIT_COMMIT}"
log "    binary          : ${INSTALLED_BIN}"
log "    log             : ${LOG_PATH}"
