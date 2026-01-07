#!/bin/bash
# =============================================================================
# Config Watchdog: Detects unauthorized changes to model config
# Restores if changed (backup protection if config unlocked)
# =============================================================================

# Source unified environment
source "$(dirname "$0")/env.sh"

EXPECTED_PRIMARY="antigravity/gemini-3-pro-low"
EXPECTED_FALLBACKS='["antigravity/claude-sonnet-4-5","antigravity/gemini-3-flash","antigravity/gemini-3-pro-high","antigravity/claude-opus-4-5","antigravity/claude-sonnet-4-5-thinking","antigravity/claude-opus-4-5-thinking"]'

log "Config watchdog check..."

# If config is locked, just verify and exit
if config_is_locked; then
  log "✅ Config is LOCKED (immutable) - no changes possible."
  exit 0
fi

# Config is unlocked - check for tampering
log "⚠️  Config is UNLOCKED - checking for unauthorized changes..."

CURRENT_PRIMARY=$(jq -r '.agent.model.primary' "$CONFIG" 2>/dev/null)
CURRENT_FALLBACKS=$(jq -c '.agent.model.fallbacks' "$CONFIG" 2>/dev/null)

CHANGED=false

if [ "$CURRENT_PRIMARY" != "$EXPECTED_PRIMARY" ]; then
  log "⚠️  PRIMARY CHANGED: $CURRENT_PRIMARY → $EXPECTED_PRIMARY"
  CHANGED=true
fi

if [ "$CURRENT_FALLBACKS" != "$EXPECTED_FALLBACKS" ]; then
  log "⚠️  FALLBACKS CHANGED!"
  CHANGED=true
fi

if [ "$CHANGED" = true ]; then
  log "🔧 RESTORING CONFIG..."
  jq --arg primary "$EXPECTED_PRIMARY" \
     --argjson fallbacks "$EXPECTED_FALLBACKS" \
     '.agent.model.primary = $primary | .agent.model.fallbacks = $fallbacks' \
     "$CONFIG" > "${CONFIG}.tmp" && mv "${CONFIG}.tmp" "$CONFIG"
  
  if [ $? -eq 0 ]; then
    log "✅ Config restored. Re-locking..."
    "$SCRIPTS_DIR/config-lock.sh" lock
  else
    log "❌ Failed to restore config!"
  fi
else
  log "✅ Config OK - re-locking..."
  "$SCRIPTS_DIR/config-lock.sh" lock
fi
