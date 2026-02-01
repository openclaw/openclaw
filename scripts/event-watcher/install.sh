#!/bin/bash
# ============================================================================
# Event Watcher Installer
# ============================================================================
# Installs event-watcher.sh and optionally sets up as a background service.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.clawdbot/scripts"
WATCHER_DIR="$TARGET_DIR/watchers"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}Warning:${NC} $*"; }
error() { echo -e "${RED}Error:${NC} $*" >&2; }

# Check requirements
check_requirements() {
    log "Checking requirements..."
    
    local missing=()
    
    # Required: jq
    if ! command -v jq &>/dev/null; then
        missing+=("jq")
    fi
    
    # Required: clawdbot or moltbot CLI
    if ! command -v clawdbot &>/dev/null && ! command -v moltbot &>/dev/null; then
        error "Neither clawdbot nor moltbot CLI found in PATH"
        error "Install Clawdbot first: npm install -g clawdbot"
        exit 1
    fi
    
    # Optional: Python with google libraries (for Gmail watcher)
    local python_ok=false
    for venv in "$HOME/clawd/.venv-google/bin/python3" "$HOME/.clawdbot/venv/bin/python3"; do
        if [ -x "$venv" ]; then
            python_ok=true
            break
        fi
    done
    
    if ! $python_ok; then
        if python3 -c "from google.oauth2.credentials import Credentials" 2>/dev/null; then
            python_ok=true
        fi
    fi
    
    if ! $python_ok; then
        warn "Python google-auth libraries not found"
        warn "Gmail watcher will not work until you install them:"
        warn "  pip install google-auth google-auth-oauthlib google-api-python-client"
    fi
    
    if [ ${#missing[@]} -gt 0 ]; then
        error "Missing required tools: ${missing[*]}"
        error "Install with: brew install ${missing[*]}  (macOS)"
        error "        or: apt install ${missing[*]}   (Linux)"
        exit 1
    fi
    
    log "Requirements OK"
}

# Install files
install_files() {
    log "Installing files..."
    
    mkdir -p "$TARGET_DIR"
    mkdir -p "$WATCHER_DIR"
    mkdir -p "$HOME/.clawdbot/logs"
    
    # Copy main script
    cp "$SCRIPT_DIR/event-watcher.sh" "$TARGET_DIR/"
    chmod +x "$TARGET_DIR/event-watcher.sh"
    
    # Copy watcher scripts
    if [ -d "$SCRIPT_DIR/watchers" ]; then
        cp "$SCRIPT_DIR/watchers"/*.py "$WATCHER_DIR/" 2>/dev/null || true
        chmod +x "$WATCHER_DIR"/*.py 2>/dev/null || true
    fi
    
    # Copy config if doesn't exist
    if [ ! -f "$HOME/.clawdbot/event-watcher.json5" ]; then
        cp "$SCRIPT_DIR/event-watcher.json5.example" "$HOME/.clawdbot/event-watcher.json5"
        log "Created config at ~/.clawdbot/event-watcher.json5"
        log "Edit this file to configure which watchers to enable"
    else
        log "Config already exists, not overwriting"
    fi
    
    log "Files installed to $TARGET_DIR"
}

# Set up service
setup_service() {
    log "Setting up background service..."
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: launchd
        local plist="$HOME/Library/LaunchAgents/com.clawdbot.event-watcher.plist"
        
        # Stop if running
        launchctl bootout gui/$(id -u)/com.clawdbot.event-watcher 2>/dev/null || true
        
        # Install plist with user's home directory
        sed "s|\$HOME|$HOME|g" "$SCRIPT_DIR/com.clawdbot.event-watcher.plist" > "$plist"
        
        # Load
        launchctl bootstrap gui/$(id -u) "$plist"
        
        log "Service installed and started"
        log "Check status: launchctl print gui/$(id -u)/com.clawdbot.event-watcher"
        log "View logs: tail -f /tmp/clawdbot-event-watcher.log"
        
    elif [[ "$OSTYPE" == "linux"* ]]; then
        # Linux: systemd user service
        mkdir -p "$HOME/.config/systemd/user"
        cp "$SCRIPT_DIR/clawdbot-event-watcher.service" "$HOME/.config/systemd/user/"
        
        systemctl --user daemon-reload
        systemctl --user enable clawdbot-event-watcher
        systemctl --user start clawdbot-event-watcher
        
        log "Service installed and started"
        log "Check status: systemctl --user status clawdbot-event-watcher"
        log "View logs: journalctl --user -u clawdbot-event-watcher -f"
    else
        warn "Unknown OS type: $OSTYPE"
        warn "Run manually: $TARGET_DIR/event-watcher.sh --loop"
    fi
}

# Main
main() {
    echo ""
    echo "====================================="
    echo "  Event Watcher Installer"
    echo "====================================="
    echo ""
    
    check_requirements
    install_files
    
    echo ""
    read -p "Set up as background service? [y/N] " -n 1 -r
    echo ""
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        setup_service
    else
        log "Skipping service setup"
        log "Run manually: $TARGET_DIR/event-watcher.sh --loop"
    fi
    
    echo ""
    log "Installation complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Edit ~/.clawdbot/event-watcher.json5 to configure watchers"
    echo "  2. Test with: EVENT_WATCHER_DEBUG=1 ~/.clawdbot/scripts/event-watcher.sh"
    echo "  3. Check logs: tail -f ~/.clawdbot/logs/event-watcher.log"
    echo ""
}

main "$@"
