#!/bin/bash
# ============================================================================
# Event Watcher - Lightweight Polling for Clawdbot
# ============================================================================
#
# A zero-LLM-cost polling system that monitors external services and wakes
# Clawdbot only when there's something new to process.
#
# Usage:
#   ./event-watcher.sh              # Run once
#   ./event-watcher.sh --loop       # Run continuously
#   ./event-watcher.sh --daemon     # Run as background daemon
#
# Configuration: ~/.clawdbot/event-watcher.json5
# State file:    ~/.clawdbot/event-watcher-state.json
#
# Environment variables:
#   EVENT_WATCHER_CONFIG - Override config file path
#   EVENT_WATCHER_DEBUG  - Enable debug output (1 = on)
#
# ============================================================================

set -euo pipefail

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${EVENT_WATCHER_CONFIG:-$HOME/.clawdbot/event-watcher.json5}"
STATE_FILE=""  # Set from config in init_config()
LOG_FILE="$HOME/.clawdbot/logs/event-watcher.log"
PID_FILE="$HOME/.clawdbot/event-watcher.pid"

# Python executable - check for venv with google libraries
PYTHON_CMD="python3"
for venv_path in \
    "$HOME/clawd/.venv-google/bin/python3" \
    "$HOME/.clawdbot/venv/bin/python3" \
    "$SCRIPT_DIR/.venv/bin/python3"; do
    if [ -x "$venv_path" ]; then
        PYTHON_CMD="$venv_path"
        break
    fi
done

# Defaults (overridden by config)
POLL_INTERVAL=30
WAKE_MODE="now"
DEBUG="${EVENT_WATCHER_DEBUG:-0}"
DRY_RUN="${EVENT_WATCHER_DRY_RUN:-0}"

# ============================================================================
# Utilities
# ============================================================================

log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $*" | tee -a "$LOG_FILE"
}

debug() {
    if [ "$DEBUG" = "1" ]; then
        log "[DEBUG] $*"
    fi
}

error() {
    log "[ERROR] $*" >&2
}

die() {
    error "$*"
    exit 1
}

# Parse JSON5/JSON config (strips comments, uses jq)
read_config() {
    local key="$1"
    local default="${2:-}"
    
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "$default"
        return
    fi
    
    # Strip // comments and parse with jq
    local value
    value=$(sed 's|//.*$||g' "$CONFIG_FILE" | jq -r "$key // \"$default\"" 2>/dev/null)
    
    if [ "$value" = "null" ] || [ -z "$value" ]; then
        echo "$default"
    else
        echo "$value"
    fi
}

# Read state for a watcher
read_state() {
    local watcher="$1"
    local key="$2"
    local default="${3:-}"
    
    if [ ! -f "$STATE_FILE" ]; then
        echo "$default"
        return
    fi
    
    jq -r ".${watcher}.${key} // \"$default\"" "$STATE_FILE" 2>/dev/null || echo "$default"
}

# Write state for a watcher
write_state() {
    local watcher="$1"
    local key="$2"
    local value="$3"
    
    mkdir -p "$(dirname "$STATE_FILE")"
    
    if [ ! -f "$STATE_FILE" ]; then
        echo "{}" > "$STATE_FILE"
    fi
    
    local tmp=$(mktemp)
    jq ".${watcher}.${key} = $value" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

# Wake Clawdbot with a system event
wake_clawdbot() {
    local message="$1"
    local mode="${2:-$WAKE_MODE}"
    
    if [ "$DRY_RUN" = "1" ]; then
        log "[DRY RUN] Would wake Clawdbot: $message"
        return 0
    fi
    
    log "Waking Clawdbot: $message"
    
    if command -v clawdbot &>/dev/null; then
        clawdbot system event --mode "$mode" --text "$message" 2>&1 || {
            error "Failed to wake Clawdbot via CLI"
            return 1
        }
    elif command -v moltbot &>/dev/null; then
        moltbot system event --mode "$mode" --text "$message" 2>&1 || {
            error "Failed to wake Clawdbot via moltbot CLI"
            return 1
        }
    else
        error "Neither clawdbot nor moltbot CLI found in PATH"
        return 1
    fi
}

# ============================================================================
# Watchers
# ============================================================================
# Each watcher function should:
#   1. Check if enabled in config
#   2. Check the external service (cheap API call)
#   3. Compare to saved state
#   4. Return events if something changed
#
# Add your own watchers here! Copy the template below.
# ============================================================================

# ----------------------------------------------------------------------------
# Gmail Watcher
# Checks for new unread emails
# ----------------------------------------------------------------------------
watcher_gmail() {
    local enabled=$(read_config '.watchers.gmail.enabled' 'false')
    if [ "$enabled" != "true" ]; then
        debug "Gmail watcher disabled"
        return
    fi
    
    local creds_file=$(read_config '.watchers.gmail.credentialsFile' "$HOME/.clawdbot/credentials/google-tokens.json")
    creds_file="${creds_file/#\~/$HOME}"
    
    if [ ! -f "$creds_file" ]; then
        debug "Gmail credentials not found: $creds_file"
        return
    fi
    
    debug "Checking Gmail..."
    
    # Get unread count via Gmail API using helper script
    local gmail_script="$SCRIPT_DIR/watchers/gmail-check.py"
    if [ ! -f "$gmail_script" ]; then
        debug "Gmail checker script not found: $gmail_script"
        return
    fi
    
    local result
    result=$("$PYTHON_CMD" "$gmail_script" "$creds_file" 2>/dev/null || echo '{"error":"script failed"}')
    
    # Check for error in JSON response
    local error_msg
    error_msg=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
    if [ -n "$error_msg" ]; then
        debug "Gmail check failed: $error_msg"
        return
    fi
    
    local count=$(echo "$result" | jq -r '.count')
    local latest_id=$(echo "$result" | jq -r '.latest_id // ""')
    local from=$(echo "$result" | jq -r '.from // ""')
    local subject=$(echo "$result" | jq -r '.subject // ""')
    
    local last_count=$(read_state "gmail" "count" "0")
    local last_id=$(read_state "gmail" "latest_id" "")
    
    debug "Gmail: $count unread (was: $last_count, last_id: $last_id, new_id: $latest_id)"
    
    # Check if there's new mail
    if [ "$count" -gt 0 ] && [ "$latest_id" != "$last_id" ]; then
        # New email arrived!
        write_state "gmail" "count" "$count"
        write_state "gmail" "latest_id" "\"$latest_id\""
        write_state "gmail" "last_check" "$(date +%s)"
        
        # Wake Clawdbot
        wake_clawdbot "[Event Watcher] New email from: $from - Subject: $subject"
    else
        # No change, just update count
        write_state "gmail" "count" "$count"
        write_state "gmail" "last_check" "$(date +%s)"
    fi
}

# ----------------------------------------------------------------------------
# Calendar Watcher
# Checks for upcoming events
# ----------------------------------------------------------------------------
watcher_calendar() {
    local enabled=$(read_config '.watchers.calendar.enabled' 'false')
    if [ "$enabled" != "true" ]; then
        debug "Calendar watcher disabled"
        return
    fi
    
    # TODO: Implement calendar checking
    # Similar pattern to Gmail - check for events in next N minutes
    debug "Calendar watcher not yet implemented"
}

# ----------------------------------------------------------------------------
# Template Watcher (copy this for new watchers)
# ----------------------------------------------------------------------------
watcher_template() {
    # 1. Check if enabled
    local enabled=$(read_config '.watchers.template.enabled' 'false')
    if [ "$enabled" != "true" ]; then
        return
    fi
    
    # 2. Check the external service (your code here)
    # local result=$(curl -s "https://api.example.com/check")
    
    # 3. Compare to saved state
    # local last_value=$(read_state "template" "some_key" "default")
    
    # 4. If changed, wake Clawdbot
    # if [ "$result" != "$last_value" ]; then
    #     write_state "template" "some_key" "\"$result\""
    #     wake_clawdbot "[Event Watcher] Something changed: $result"
    # fi
    
    :  # No-op placeholder
}

# ============================================================================
# ADD YOUR CUSTOM WATCHERS HERE
# ============================================================================
# Copy watcher_template above and customize for your needs.
# Examples:
#   - Matrix room checker
#   - RSS feed monitor
#   - Website change detector
#   - API status checker
#   - File system watcher
# ============================================================================


# ============================================================================
# Main Loop
# ============================================================================

run_all_watchers() {
    debug "Running all watchers..."
    
    # Run each watcher in a subshell to prevent one failure from killing the loop
    # This overrides set -e behavior for individual watchers
    (watcher_gmail) || debug "Gmail watcher returned non-zero"
    (watcher_calendar) || debug "Calendar watcher returned non-zero"
    (watcher_template) || debug "Template watcher returned non-zero"
    
    # Add calls to your custom watchers here:
    # (watcher_my_custom_source) || debug "Custom watcher returned non-zero"
    
    debug "Watcher cycle complete"
}

# Initialize config values
init_config() {
    STATE_FILE=$(read_config '.stateFile' "$HOME/.clawdbot/event-watcher-state.json")
    STATE_FILE="${STATE_FILE/#\~/$HOME}"
    POLL_INTERVAL=$(read_config '.pollIntervalSeconds' '30')
    WAKE_MODE=$(read_config '.wakeMode' 'now')
}

run_once() {
    init_config
    log "Event Watcher running (single check)"
    run_all_watchers
}

run_loop() {
    init_config
    log "Event Watcher starting (continuous mode, interval: ${POLL_INTERVAL}s)"
    
    while true; do
        run_all_watchers
        debug "Sleeping for ${POLL_INTERVAL}s..."
        sleep "$POLL_INTERVAL"
    done
}

run_daemon() {
    log "Event Watcher starting as daemon"
    
    # Check if already running
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        die "Event Watcher already running (PID: $(cat "$PID_FILE"))"
    fi
    
    # Daemonize
    mkdir -p "$(dirname "$LOG_FILE")"
    nohup "$0" --loop >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    log "Daemon started (PID: $!)"
}

stop_daemon() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            log "Stopping daemon (PID: $pid)"
            kill "$pid"
            rm -f "$PID_FILE"
        else
            log "Daemon not running, removing stale PID file"
            rm -f "$PID_FILE"
        fi
    else
        log "No PID file found"
    fi
}

show_help() {
    cat <<EOF
Event Watcher - Lightweight Polling for Clawdbot

Usage: $0 [command]

Commands:
  (none)      Run a single check cycle
  --loop      Run continuously
  --daemon    Start as background daemon
  --stop      Stop the daemon
  --status    Show daemon status
  --dry-run   Check sources but don't actually wake (safe testing)
  --help      Show this help

Configuration: $CONFIG_FILE
State file:    (from config, default: ~/.clawdbot/event-watcher-state.json)
Log file:      $LOG_FILE

Environment:
  EVENT_WATCHER_CONFIG   Override config file path
  EVENT_WATCHER_DEBUG    Enable debug output (1 = on)
  EVENT_WATCHER_DRY_RUN  Don't actually wake, just log (1 = on)

EOF
}

show_status() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Event Watcher is running (PID: $pid)"
            echo "Log: $LOG_FILE"
            echo ""
            echo "Recent log entries:"
            tail -10 "$LOG_FILE" 2>/dev/null || echo "(no logs)"
        else
            echo "Event Watcher not running (stale PID file)"
        fi
    else
        echo "Event Watcher not running"
    fi
}

# Main entry point
main() {
    mkdir -p "$HOME/.clawdbot/logs"
    
    case "${1:-}" in
        --loop)
            run_loop
            ;;
        --daemon)
            run_daemon
            ;;
        --stop)
            stop_daemon
            ;;
        --status)
            show_status
            ;;
        --dry-run)
            DRY_RUN=1
            DEBUG=1
            run_once
            ;;
        --help|-h)
            show_help
            ;;
        "")
            run_once
            ;;
        *)
            die "Unknown command: $1 (use --help for usage)"
            ;;
    esac
}

main "$@"
