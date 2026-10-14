#!/bin/bash
# Auth Monitor
# Run via cron or systemd timer to get native login alerts and
# proactive notifications before OpenClaw-managed credentials expire.
#
# For cron, set PATH to include the openclaw and node executable directories.
# Suggested cron: */30 * * * * /path/to/openclaw/scripts/auth-monitor.sh
#
# Environment variables:
#   NOTIFY_PHONE - Phone number to send OpenClaw notification (e.g., +1234567890)
#   NOTIFY_NTFY  - ntfy.sh topic for push notifications (e.g., openclaw-alerts)
#   WARN_HOURS   - Hours before managed credential expiry to warn (default: 2)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$HOME/.openclaw/auth-monitor-state"

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
    local notification_sent=0

    echo "$(date '+%Y-%m-%d %H:%M:%S') - $message"

    if [ $((NOW - LAST_NOTIFIED)) -lt $MIN_INTERVAL ]; then
        echo "Skipping notification (sent recently)"
        return
    fi

    if [ -n "$NOTIFY_PHONE" ]; then
        local auth_status="" auth_exit=0
        auth_status="$("$SCRIPT_DIR/claude-auth-status.sh" simple 2>/dev/null)" || auth_exit=$?
        # Expiring credentials remain usable; the status helper reports them with exit 2.
        if [[ "$auth_exit" -eq 0 && "$auth_status" == "OK" ]] ||
           [[ "$auth_exit" -eq 2 && ( "$auth_status" == "CLAUDE_EXPIRING" || "$auth_status" == "OPENCLAW_EXPIRING" ) ]]; then
            echo "Sending via OpenClaw to $NOTIFY_PHONE..."
            if openclaw message send --target "$NOTIFY_PHONE" --message "$message" 2>/dev/null; then
                notification_sent=1
            fi
        fi
    fi

    if [ -n "$NOTIFY_NTFY" ]; then
        echo "Sending via ntfy.sh to $NOTIFY_NTFY..."
        if curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null \
            -H "Title: OpenClaw Auth Alert" \
            -H "Priority: $priority" \
            -H "Tags: warning,key" \
            -d "$message" \
            "https://ntfy.sh/$NOTIFY_NTFY"; then
            notification_sent=1
        fi
    fi

    if [ "$notification_sent" -eq 1 ]; then
        echo "$NOW" > "$STATE_FILE"
    else
        echo "No notification delivered; cooldown not updated" >&2
    fi
}

STATUS_JSON=$("$SCRIPT_DIR/claude-auth-status.sh" json) || {
    echo "Auth status unavailable; not requesting re-authentication." >&2
    exit 3
}
CLAUDE_STATUS=$(printf '%s\n' "$STATUS_JSON" | jq -r '.claude_code.status')
OPENCLAW_STATUS=$(printf '%s\n' "$STATUS_JSON" | jq -r '.openclaw.status')

if [ "$CLAUDE_STATUS" = "MISSING" ]; then
    MESSAGE=$(printf '%s\n' "$STATUS_JSON" | jq -r '.claude_code.message // "Claude Code login missing. Run: claude auth login"')
    send_notification "$MESSAGE" "high"
    exit 1
fi

case "$OPENCLAW_STATUS" in
    MISSING*|EXPIRED*)
        send_notification "OpenClaw-managed auth missing or expired. Run: openclaw models auth login --provider anthropic" "urgent"
        exit 1
        ;;
    UNKNOWN)
        echo "Auth status unavailable; not requesting re-authentication." >&2
        exit 3
        ;;
esac

EXPIRES_AT=$(printf '%s\n' "$STATUS_JSON" | jq -r '.openclaw.expires_at_ms')
if [ "$EXPIRES_AT" -gt 0 ]; then
    DIFF_MS=$((EXPIRES_AT - NOW * 1000))
    HOURS_LEFT=$((DIFF_MS / 3600000))
    MINS_LEFT=$(((DIFF_MS % 3600000) / 60000))

    if [ "$DIFF_MS" -le 0 ]; then
        send_notification "OpenClaw-managed auth expired. Run: openclaw models auth login --provider anthropic" "urgent"
        exit 1
    elif [ "$DIFF_MS" -lt $((WARN_HOURS * 3600000)) ]; then
        send_notification "OpenClaw-managed auth expires in ${HOURS_LEFT}h ${MINS_LEFT}m. Consider re-auth soon." "high"
        exit 0
    fi
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') - Auth OK (Claude Code: $CLAUDE_STATUS; OpenClaw: $OPENCLAW_STATUS)"
