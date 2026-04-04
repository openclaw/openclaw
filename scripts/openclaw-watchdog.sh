#!/bin/bash
#
# openclaw-watchdog.sh — OpenClaw Gateway Health Watchdog
#
# A lightweight external watchdog that monitors the OpenClaw Gateway health endpoint.
# If the gateway is unresponsive, it attempts a restart and sends a macOS notification.
#
# Usage:
#   ./openclaw-watchdog.sh --interval-minutes 3 --gateway-url http://localhost:18789
#
# Or run via the CLI: openclaw gateway watchdog --interval 3
#
# NOTE: This script is NOT run automatically. Add it to your launchd/systemd
# or a process supervisor (like launchAgents/macOS or systemd/Linux) to
# ensure it runs continuously in the background.
#
set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
INTERVAL_MINUTES=5
GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://localhost:18789}"
TOKEN=""
MAX_RESTART_ATTEMPTS=3
NOTIFY=true
LOG_FILE="${OPENCLAW_LOG_DIR:-$HOME/.openclaw/logs}/watchdog.log"

# ── Helpers ──────────────────────────────────────────────────────────────────
log() {
  local msg="[$(date '+%Y-%m-%dT%H:%M:%S')] [watchdog] $*"
  echo "$msg" >> "$LOG_FILE"
  echo "$msg" >&2
}

send_notify() {
  [[ "$NOTIFY" != "true" ]] && return 0
  case "$(uname -s)" in
    Darwin)
      osascript -e "display notification \"$1\" with title \"OpenClaw Watchdog\"" 2>/dev/null || true
      ;;
    Linux)
      command -v notify-send >/dev/null 2>&1 && notify-send "OpenClaw Watchdog" "$1" || true
      ;;
  esac
}

restart_gateway() {
  local attempts="$1"
  log "Attempting to restart OpenClaw Gateway (attempt $attempts/$MAX_RESTART_ATTEMPTS)..."
  send_notify "OpenClaw Gateway is down. Restarting (attempt $attempts)..."

  # Try openclaw CLI first, then direct service restart
  if command -v openclaw >/dev/null 2>&1; then
    openclaw gateway restart 2>&1 | tee -a "$LOG_FILE" || true
  else
    log "openclaw CLI not found in PATH. Please restart manually."
    send_notify "OpenClaw Gateway is DOWN and openclaw CLI not found. Please restart manually."
    return 1
  fi
}

LAST_STATUS_CODE=""

check_gateway() {
  local health_url="${GATEWAY_URL}/health"

  LAST_STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 10 \
    -H "Authorization: Bearer ${TOKEN}" \
    "$health_url" 2>/dev/null || echo "000")

  case "$LAST_STATUS_CODE" in
    200|429)  # 429 = rate limited but gateway is alive
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# ── Argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval-minutes|--interval)
      INTERVAL_MINUTES="$2"; shift 2
      ;;
    --gateway-url|--url)
      GATEWAY_URL="$2"; shift 2
      ;;
    --token)
      TOKEN="$2"; shift 2
      ;;
    --max-attempts)
      MAX_RESTART_ATTEMPTS="$2"; shift 2
      ;;
    --no-notify)
      NOTIFY=false; shift
      ;;
    --log-file)
      LOG_FILE="$2"; shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo "  --interval-minutes N   Minutes between health checks (default: 5)"
      echo "  --gateway-url URL      Gateway health endpoint URL (default: http://localhost:18789)"
      echo "  --token TOKEN          Optional auth token for the gateway"
      echo "  --max-attempts N       Max restart attempts before giving up (default: 3)"
      echo "  --no-notify            Disable macOS/Linux notifications"
      echo "  --log-file PATH        Path to log file (default: ~/.openclaw/logs/watchdog.log)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2; exit 1
      ;;
  esac
done

# ── Main loop ────────────────────────────────────────────────────────────────
INTERVAL_SECONDS=$((INTERVAL_MINUTES * 60))
[[ $INTERVAL_SECONDS -lt 30 ]] && INTERVAL_SECONDS=30

mkdir -p "$(dirname "$LOG_FILE")"

log "OpenClaw Watchdog started."
log "  Gateway URL: $GATEWAY_URL/health"
log "  Check interval: ${INTERVAL_SECONDS}s"
log "  Max restart attempts: $MAX_RESTART_ATTEMPTS"
log "  Notifications: $NOTIFY"

if ! command -v curl >/dev/null 2>&1; then
  log "ERROR: curl is required but not found. Install curl to use the watchdog."
  exit 1
fi

restart_attempts=0

while true; do
  if check_gateway; then
    if [[ $restart_attempts -gt 0 ]]; then
      log "Gateway is back up (was down for $restart_attempts restart attempts)."
      send_notify "OpenClaw Gateway is back up! ✓"
      restart_attempts=0
    fi
    log "Gateway is healthy (HTTP OK)."
  else
    log "Gateway is DOWN (HTTP ${LAST_STATUS_CODE})."

    if [[ $restart_attempts -lt $MAX_RESTART_ATTEMPTS ]]; then
      ((restart_attempts++)) || true
      restart_gateway $restart_attempts

      # Wait for restart to take effect before checking again
      log "Waiting ${INTERVAL_SECONDS}s before re-checking..."
      sleep "$INTERVAL_SECONDS"
      continue
    else
      log "Max restart attempts ($MAX_RESTART_ATTEMPTS) reached. Gateway may need manual intervention."
      send_notify "OpenClaw Gateway is DOWN. Max restart attempts reached. Manual intervention required."
    fi
  fi

  sleep "$INTERVAL_SECONDS"
done
