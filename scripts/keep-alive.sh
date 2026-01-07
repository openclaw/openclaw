#!/bin/bash
# =============================================================================
# Keep-Alive: Ensures clawdbot gateway is always running
# Runs via cron every 2 minutes
# =============================================================================

# Source unified environment
source "$(dirname "$0")/env.sh"

log "Checking clawdbot status..."

# Check if gateway is running (port check)
if lsof -i :$PORT > /dev/null 2>&1; then
  # Additional health check via HTTP
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    log "✅ Status: ONLINE (Port $PORT active, health OK)"
  else
    log "⚠️  Status: DEGRADED (Port $PORT active, but health check failed)"
  fi
  exit 0
else
  log "❌ Status: OFFLINE (Port $PORT closed). Initiating restart..."
  "$SCRIPTS_DIR/models.sh" restart
  log "Restart command executed."
fi
