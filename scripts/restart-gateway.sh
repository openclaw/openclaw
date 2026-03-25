#!/usr/bin/env bash
# Restart EVOX gateway after build (native agents only, not Docker)
# Called automatically at end of build script

set -euo pipefail

log() { printf '[restart-gateway] %s\n' "$*"; }

# Check if running under launchd
LAUNCHD_LABEL="ai.evox.gateway"
LEGACY_LABEL="ai.openclaw.gateway"

restart_launchd() {
  local label="$1"
  if launchctl list "$label" &>/dev/null; then
    log "Restarting $label via launchd..."
    launchctl stop "$label" 2>/dev/null || true
    sleep 2
    launchctl start "$label" 2>/dev/null || true
    log "Done: $label restarted"
    return 0
  fi
  return 1
}

# Try new label first, then legacy
if restart_launchd "$LAUNCHD_LABEL"; then
  exit 0
fi

if restart_launchd "$LEGACY_LABEL"; then
  exit 0
fi

# No launchd agent found - try direct process restart
log "No launchd agent found, attempting direct process restart..."
pkill -f "evox-gateway" 2>/dev/null || true
sleep 2

# Gateway should auto-restart if configured, otherwise warn
if pgrep -f "evox-gateway" &>/dev/null; then
  log "Gateway restarted successfully"
else
  log "WARNING: Gateway not running. Start manually with: evox gateway"
fi
