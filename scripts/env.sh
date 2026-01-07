#!/bin/bash
# =============================================================================
# Unified environment for all clawdbot scripts
# Source this at the top of every script: source "$(dirname "$0")/env.sh"
# =============================================================================

# Comprehensive PATH for cron environment
export PATH="/usr/sbin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:$PATH"

# Core directories
export CLAWDBOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
export SCRIPTS_DIR="$CLAWDBOT_DIR/scripts"
export CONFIG="$HOME/.clawdbot/clawdbot.json"
export LOG_DIR="$HOME/.clawdbot/logs"

# Gateway settings
export PORT=18789

# Ensure log directory exists
mkdir -p "$LOG_DIR" 2>/dev/null

# Helper: Check if config is locked
config_is_locked() {
  ls -lO "$CONFIG" 2>/dev/null | grep -q "uchg"
}

# Helper: Log with timestamp
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}
