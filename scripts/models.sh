#!/bin/bash
# =============================================================================
# Models: Gateway management and model config display
# Usage: ./scripts/models.sh [edit|restart|show]
# =============================================================================

# Source unified environment
source "$(dirname "$0")/env.sh"

wait_for_port() {
  local port=$1
  for i in {1..10}; do
    if ! lsof -i :$port > /dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for port $port to clear... ($i/10)"
    sleep 1
  done
  return 1
}

restart_gateway() {
  log "Restarting gateway..."
  
  # Try graceful kill first
  pkill -f "bun.*gateway --port $PORT" 2>/dev/null
  pkill -f "node.*gateway.*$PORT" 2>/dev/null
  pkill -f "tsx.*gateway.*$PORT" 2>/dev/null
  
  if ! wait_for_port $PORT; then
    log "Port $PORT still in use. Forcing cleanup..."
    lsof -ti :$PORT | xargs kill -9 2>/dev/null
    sleep 1
  fi

  # Start gateway in background
  cd "$CLAWDBOT_DIR" && pnpm clawdbot gateway --port $PORT &
  
  # Verify start
  sleep 3
  if lsof -i :$PORT > /dev/null 2>&1; then
    log "✅ Gateway restarted successfully on port $PORT."
    
    # Auto-lock config after successful restart
    "$SCRIPTS_DIR/config-lock.sh" lock
    return 0
  else
    log "❌ Gateway failed to start. Check logs."
    return 1
  fi
}

case "${1:-show}" in
  edit)
    # Unlock config for editing
    if config_is_locked; then
      "$SCRIPTS_DIR/config-lock.sh" unlock
    fi
    
    ${EDITOR:-nano} "$CONFIG"
    echo "Config saved."
    restart_gateway
    ;;
  restart)
    restart_gateway
    ;;
  show)
    echo "=== Model Priority ==="
    echo "Primary: $(jq -r '.agent.model.primary' "$CONFIG")"
    echo ""
    echo "Fallbacks:"
    jq -r '.agent.model.fallbacks[]' "$CONFIG" | nl
    echo ""
    echo "Config Lock: $(config_is_locked && echo '🔒 LOCKED' || echo '🔓 UNLOCKED')"
    ;;
  *)
    echo "Usage: $0 [edit|restart|show]"
    echo "  show    - Display current model priority (default)"
    echo "  edit    - Edit config and restart gateway"
    echo "  restart - Just restart gateway"
    ;;
esac
