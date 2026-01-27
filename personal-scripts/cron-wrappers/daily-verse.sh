#!/bin/bash
# System cron wrapper for daily-verse
# Schedule: 6:05 AM daily (5 6 * * *)

# Ensure gateway is running
source /Users/steve/clawd/personal-scripts/cron-wrappers/ensure-gateway.sh
ensure_gateway

MOLTBOT="/Users/steve/Library/pnpm/moltbot"

# Run the verse script and get JSON
JSON_OUTPUT=$(python3 /Users/steve/clawd/skills/bible/votd.py --download /tmp/votd.jpg 2>&1) || true

# Parse JSON and format message
if [ -n "$JSON_OUTPUT" ]; then
    TEXT=$(echo "$JSON_OUTPUT" | jq -r '.text // empty')
    REFERENCE=$(echo "$JSON_OUTPUT" | jq -r '.reference // empty')

    if [ -n "$TEXT" ] && [ -n "$REFERENCE" ]; then
        MESSAGE="📖 ${REFERENCE}

${TEXT}"

        if [ -f /tmp/votd.jpg ]; then
            "$MOLTBOT" message send --channel telegram --account steve --target 1191367022 --message "$MESSAGE" --media /tmp/votd.jpg 2>&1
        else
            "$MOLTBOT" message send --channel telegram --account steve --target 1191367022 --message "$MESSAGE" 2>&1
        fi
    fi
fi
