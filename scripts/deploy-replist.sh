#!/usr/bin/env bash
# Authored by: cc (Claude Code) | 2026-03-15
# Re-apply the ~/.openclaw/dist/index.js gateway plist entry after
# `openclaw doctor --fix` or `openclaw daemon install` reverts it.
#
# Usage:
#   pnpm deploy:replist
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${HOME}/.openclaw"
DIST_DEST="${DEPLOY_DIR}/dist"
LAUNCHD_LABEL="ai.openclaw.gateway"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
DESIRED_ENTRY="${DIST_DEST}/index.js"

log() { printf '[deploy-replist] %s\n' "$*"; }

if [[ ! -f "${PLIST_PATH}" ]]; then
  log "ERROR: plist not found at ${PLIST_PATH}"
  exit 1
fi

if [[ ! -f "${DESIRED_ENTRY}" ]]; then
  log "ERROR: ${DESIRED_ENTRY} not found — run pnpm deploy:local first"
  exit 1
fi

CURRENT_ENTRY="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "${PLIST_PATH}" 2>/dev/null || true)"

if [[ "${CURRENT_ENTRY}" == "${DESIRED_ENTRY}" ]]; then
  log "Plist already correct (${DESIRED_ENTRY}) — nothing to do"
else
  log "Reverting plist: ${CURRENT_ENTRY} → ${DESIRED_ENTRY}"
  launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  /usr/bin/plutil -replace 'ProgramArguments.1' -string "${DESIRED_ENTRY}" "${PLIST_PATH}"
  log "Plist updated"
fi

log "Restarting gateway..."
launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
sleep 3
log "Gateway restarted. Checking status..."
openclaw gateway status --deep || log "WARNING: gateway status check failed — check logs at ${DEPLOY_DIR}/logs/gateway.log"

log "Done. Gateway running from ${DESIRED_ENTRY}"
