#!/usr/bin/env bash
# disk-monitor.sh
# Checks disk usage on bodhi1. Alerts via Telegram if root partition > 85%.
# Called by OpenClaw cron daily. Silent if healthy.

set -euo pipefail

WARN_THRESHOLD=85
CRIT_THRESHOLD=95

# Root partition usage
USAGE=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %')

if [[ -z "$USAGE" || ! "$USAGE" =~ ^[0-9]+$ ]]; then
    echo "DISK_WARN: could not read disk usage"
    exit 0
fi

if (( USAGE >= CRIT_THRESHOLD )); then
    echo "DISK_CRITICAL: root partition at ${USAGE}% — immediate action needed. Check: df -h && du -sh ~/* | sort -rh | head -10"
elif (( USAGE >= WARN_THRESHOLD )); then
    echo "DISK_WARN: root partition at ${USAGE}% (threshold: ${WARN_THRESHOLD}%). Run: df -h to inspect."
fi
# Below threshold: silent exit
exit 0
