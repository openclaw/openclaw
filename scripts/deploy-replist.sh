#!/usr/bin/env bash
# Authored by: cc (Claude Code) | 2026-03-15
# Re-apply the openclaw-stable dist/index.js gateway plist entry after
# `openclaw doctor --fix` or `openclaw daemon install` reverts it.
#
# Usage:
#   pnpm deploy:replist
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STABLE_DIR="${REPO_DIR}/../openclaw-stable"
STABLE_DIR="$(cd "${STABLE_DIR}" 2>/dev/null && pwd || echo "${REPO_DIR}/../openclaw-stable")"
DIST_DEST="${STABLE_DIR}/dist"
LAUNCHD_LABEL="ai.openclaw.gateway"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
DESIRED_ENTRY="${DIST_DEST}/index.js"
WATCHDOG_LABELS=("ai.openclaw.watchdog" "com.openclaw.watchdog")
WATCHDOG_USER_PLIST="${HOME}/Library/LaunchAgents/ai.openclaw.watchdog.plist"
WATCHDOG_SYS_PLIST="/Library/LaunchAgents/com.openclaw.watchdog.plist"

log() { printf '[deploy-replist] %s\n' "$*"; }

if [[ ! -f "${PLIST_PATH}" ]]; then
  log "ERROR: plist not found at ${PLIST_PATH}"
  exit 1
fi

if [[ ! -f "${DESIRED_ENTRY}" ]]; then
  log "ERROR: ${DESIRED_ENTRY} not found — run pnpm deploy:stable first"
  exit 1
fi

# Pause watchdog agents so they can't race against our plist edit + restart
for wl in "${WATCHDOG_LABELS[@]}"; do
  launchctl bootout "gui/$(id -u)/${wl}" 2>/dev/null || true
  launchctl bootout "system/${wl}" 2>/dev/null || true
done
log "Watchdog agents paused"

# Edit plist while gateway is still running (launchd reads it only at bootstrap)
CURRENT_ENTRY="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "${PLIST_PATH}" 2>/dev/null || true)"
if [[ "${CURRENT_ENTRY}" != "${DESIRED_ENTRY}" ]]; then
  log "Fixing plist index 1: ${CURRENT_ENTRY} → ${DESIRED_ENTRY}"
  /usr/bin/plutil -replace 'ProgramArguments.1' -string "${DESIRED_ENTRY}" "${PLIST_PATH}"
fi

# Remove stale extra JS path at index 2 inserted by doctor --fix
INDEX2="$(/usr/bin/plutil -extract ProgramArguments.2 raw -o - "${PLIST_PATH}" 2>/dev/null || true)"
if [[ "${INDEX2}" == *.js ]]; then
  /usr/bin/plutil -remove 'ProgramArguments.2' "${PLIST_PATH}"
  log "Removed stale path at ProgramArguments[2]: ${INDEX2}"
fi

VERIFIED="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "${PLIST_PATH}")"
if [[ "${VERIFIED}" != "${DESIRED_ENTRY}" ]]; then
  log "ERROR: plist verification failed — index 1 is ${VERIFIED}"
  exit 1
fi
log "Plist verified: ${VERIFIED}"

log "Restarting gateway..."
launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
sleep 3
launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
sleep 5
log "Gateway restarted. Checking status..."
openclaw gateway status --deep || log "WARNING: gateway status check failed — check ${HOME}/.openclaw/logs/gateway.log"

[[ -f "${WATCHDOG_USER_PLIST}" ]] && launchctl bootstrap "gui/$(id -u)" "${WATCHDOG_USER_PLIST}" 2>/dev/null || true
[[ -f "${WATCHDOG_SYS_PLIST}" ]] && launchctl bootstrap "gui/$(id -u)" "${WATCHDOG_SYS_PLIST}" 2>/dev/null || true
log "Watchdog agents resumed"

log "Done. Gateway running from ${DESIRED_ENTRY}"
