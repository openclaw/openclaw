#!/bin/bash
# Auth Expiry Monitor
# Run via cron or systemd timer to get proactive notifications
# before Claude Code auth expires.
#
# Suggested cron: */30 * * * * /path/to/openclaw/scripts/auth-monitor.sh
#
# Environment variables:
#   NOTIFY_PHONE - Phone number to send OpenClaw notification (e.g., +1234567890)
#   NOTIFY_NTFY  - ntfy.sh topic for push notifications (e.g., openclaw-alerts)
#   WARN_HOURS   - Hours before expiry to warn (default: 2)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_CLAUDE_HOME="${OPENCLAW_SHARED_CLAUDE_HOME:-/data/agent-state/claude-home}"
STATE_FILE="$HOME/.openclaw/auth-monitor-state"

resolve_claude_creds() {
    if [ -n "${CLAUDE_CREDS:-}" ]; then
        printf '%s\n' "$CLAUDE_CREDS"
        return
    fi
    for candidate in \
        "${CLAUDE_CONFIG_DIR:-}/.credentials.json" \
        "${CLAUDE_CONFIG_DIR:-}/.claude/.credentials.json" \
        "$SHARED_CLAUDE_HOME/.credentials.json" \
        "$SHARED_CLAUDE_HOME/.claude/.credentials.json" \
        "$HOME/.claude/.credentials.json" \
        "$HOME/.credentials.json"
    do
        if [ -n "$candidate" ] && [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return
        fi
    done
    printf '%s\n' "$SHARED_CLAUDE_HOME/.credentials.json"
}

CLAUDE_CREDS="$(resolve_claude_creds)"

claude_creds_value() {
    local field="$1"
    local default_value="$2"
    python3 - "$CLAUDE_CREDS" "$field" "$default_value" <<'PY'
import json
import sys

path, field, default = sys.argv[1:4]
try:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    for part in field.split("."):
        value = value[part]
except Exception:
    print(default)
else:
    if value is None or isinstance(value, (dict, list)):
        print(default)
    else:
        print(value)
PY
}

# Configuration
WARN_HOURS="${WARN_HOURS:-2}"
NOTIFY_PHONE="${NOTIFY_PHONE:-}"
NOTIFY_NTFY="${NOTIFY_NTFY:-}"

# State tracking to avoid spam
mkdir -p "$(dirname "$STATE_FILE")"
LAST_NOTIFIED=$(cat "$STATE_FILE" 2>/dev/null || echo "0")
NOW=$(date +%s)

# Only notify once per hour max
MIN_INTERVAL=3600

send_notification() {
    local message="$1"
    local priority="${2:-default}"

    echo "$(date '+%Y-%m-%d %H:%M:%S') - $message"

    # Check if we notified recently
    if [ $((NOW - LAST_NOTIFIED)) -lt $MIN_INTERVAL ]; then
        echo "Skipping notification (sent recently)"
        return
    fi

    # Send via OpenClaw if phone configured and auth still valid
    if [ -n "$NOTIFY_PHONE" ]; then
        # Check if we can still use openclaw
        if "$SCRIPT_DIR/claude-auth-status.sh" simple 2>/dev/null | grep -q "OK\|EXPIRING"; then
            echo "Sending via OpenClaw to $NOTIFY_PHONE..."
            openclaw send --to "$NOTIFY_PHONE" --message "$message" 2>/dev/null || true
        fi
    fi

    # Send via ntfy.sh if configured
    if [ -n "$NOTIFY_NTFY" ]; then
        echo "Sending via ntfy.sh to $NOTIFY_NTFY..."
        curl -s -o /dev/null \
            -H "Title: OpenClaw Auth Alert" \
            -H "Priority: $priority" \
            -H "Tags: warning,key" \
            -d "$message" \
            "https://ntfy.sh/$NOTIFY_NTFY" || true
    fi

    # Update state
    echo "$NOW" > "$STATE_FILE"
}

# Check auth status
if [ ! -f "$CLAUDE_CREDS" ]; then
    send_notification "Claude Code credentials missing! Run: claude setup-token" "high"
    exit 1
fi

EXPIRES_AT=$(claude_creds_value "claudeAiOauth.expiresAt" "0")
REFRESH_TOKEN=$(claude_creds_value "claudeAiOauth.refreshToken" "")
HAS_REFRESH=0
if [ -n "$REFRESH_TOKEN" ]; then
    HAS_REFRESH=1
fi
NOW_MS=$((NOW * 1000))
DIFF_MS=$((EXPIRES_AT - NOW_MS))
HOURS_LEFT=$((DIFF_MS / 3600000))
MINS_LEFT=$(((DIFF_MS % 3600000) / 60000))

if [ "$DIFF_MS" -lt 0 ] && [ "$HAS_REFRESH" = "1" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Auth refreshable: access token expired but refresh token is present"
    exit 0
elif [ "$DIFF_MS" -lt 0 ]; then
    send_notification "Claude Code auth EXPIRED! OpenClaw is down. Run on the OpenClaw host: ${SCRIPT_DIR}/mobile-reauth.sh" "urgent"
    exit 1
elif [ "$HOURS_LEFT" -lt "$WARN_HOURS" ] && [ "$HAS_REFRESH" = "1" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Auth refreshable: access token expires in ${HOURS_LEFT}h ${MINS_LEFT}m and refresh token is present"
    exit 0
elif [ "$HOURS_LEFT" -lt "$WARN_HOURS" ]; then
    send_notification "Claude Code auth expires in ${HOURS_LEFT}h ${MINS_LEFT}m. Consider re-auth soon." "high"
    exit 0
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Auth OK: ${HOURS_LEFT}h ${MINS_LEFT}m remaining"
    exit 0
fi
