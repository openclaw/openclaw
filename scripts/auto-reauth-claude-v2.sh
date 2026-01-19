#!/bin/bash
# Auto Re-authentication for Claude Code
# Checks token expiry and helps maintain authentication
#
# Usage:
#   auto-reauth-claude-v2.sh          # Check and sync if needed
#   auto-reauth-claude-v2.sh --force  # Force sync even if not expired
#   auto-reauth-claude-v2.sh --check  # Just check, don't sync

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYCHAIN_SERVICE="Claude Code-credentials"
LOG_FILE="$HOME/.clawdbot/logs/auto-reauth.log"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Logging function
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}$*${NC}" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}$*${NC}" | tee -a "$LOG_FILE"; }
error() { echo -e "${RED}$*${NC}" | tee -a "$LOG_FILE"; }

# Parse arguments
MODE="auto"
if [ "${1:-}" = "--force" ]; then
  MODE="force"
elif [ "${1:-}" = "--check" ]; then
  MODE="check"
fi

log "=== Auto Re-auth Start (mode: $MODE) ==="

# Check if Claude Code token exists in keychain
if ! security find-generic-password -s "$KEYCHAIN_SERVICE" -w &>/dev/null; then
  warn "Claude Code token not found in keychain"
  warn "Please run: claude /login"
  exit 1
fi

# Read token data
TOKEN_DATA=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "dydo" -w 2>/dev/null)
EXPIRES_AT=$(echo "$TOKEN_DATA" | jq -r '.claudeAiOauth.expiresAt // 0')

# Calculate expiry time
CURRENT_TIME=$(date +%s)
EXPIRES_AT_SEC=$((EXPIRES_AT / 1000))
TIME_DIFF=$((EXPIRES_AT_SEC - CURRENT_TIME))
HOURS_LEFT=$((TIME_DIFF / 3600))
MINS_LEFT=$(((TIME_DIFF % 3600) / 60))

# Check if expired
if [ $TIME_DIFF -lt 0 ]; then
  error "Token EXPIRED $((-TIME_DIFF / 3600)) hours ago"
  warn "Please run: claude /login"
  
  # Try to send notification if possible
  if command -v osascript &>/dev/null; then
    osascript -e 'display notification "Claude Code token expired. Please run: claude /login" with title "Clawdbot Auth"' 2>/dev/null || true
  fi
  
  exit 1
elif [ $TIME_DIFF -lt 3600 ]; then
  warn "Token expiring soon: ${MINS_LEFT} minutes left"
elif [ $MODE = "force" ] || [ $MODE = "check" ]; then
  info "Token valid for ${HOURS_LEFT}h ${MINS_LEFT}m"
else
  log "Token valid for ${HOURS_LEFT}h ${MINS_LEFT}m (OK)"
fi

# Exit if check-only mode
if [ "$MODE" = "check" ]; then
  exit 0
fi

# Sync to Clawdbot
if [ -f "$SCRIPT_DIR/sync-anthropic-keychain.sh" ]; then
  info "Syncing token to Clawdbot..."
  if "$SCRIPT_DIR/sync-anthropic-keychain.sh"; then
    info "Sync successful"
  else
    error "Sync failed"
    exit 1
  fi
else
  warn "sync-anthropic-keychain.sh not found, skipping sync"
fi

log "=== Auto Re-auth Complete ==="
