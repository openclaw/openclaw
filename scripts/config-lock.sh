#!/bin/bash
# =============================================================================
# Config Lock: Makes clawdbot.json immutable to prevent any writes
# Usage: config-lock.sh [lock|unlock|status]
# =============================================================================

# Source unified environment
source "$(dirname "$0")/env.sh"

lock_config() {
  chflags uchg "$CONFIG"
  log "🔒 Config LOCKED - write access disabled."
}

unlock_config() {
  chflags nouchg "$CONFIG"
  log "🔓 Config UNLOCKED - write access enabled."
}

check_status() {
  if config_is_locked; then
    echo "🔒 Config is LOCKED (immutable)"
    return 0
  else
    echo "🔓 Config is UNLOCKED (writable)"
    return 1
  fi
}

case "${1:-status}" in
  lock)
    lock_config
    ;;
  unlock)
    unlock_config
    ;;
  status)
    check_status
    ;;
  *)
    echo "Usage: $0 [lock|unlock|status]"
    echo "  lock   - Make config immutable (no writes allowed)"
    echo "  unlock - Allow writes (for manual edits)"
    echo "  status - Show current lock status"
    ;;
esac
