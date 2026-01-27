#!/bin/bash
# System cron wrapper for daily-recap-posterboard
# Schedule: 5:00 PM daily (0 17 * * *)

# Ensure gateway is running
source /Users/steve/clawd/personal-scripts/cron-wrappers/ensure-gateway.sh
ensure_gateway

SCRIPT="/Users/steve/clawd/personal-scripts/daily-recap-steve.sh"
MOLTBOT="/Users/steve/Library/pnpm/moltbot"

# Run the actual script
OUTPUT=$("$SCRIPT" 2>&1) || true

# Parse output for MEDIA line
MEDIA_PATH=""
TEXT_OUTPUT=""
while IFS= read -r line; do
    if [[ "$line" == MEDIA:* ]]; then
        MEDIA_PATH="${line#MEDIA:}"
    else
        TEXT_OUTPUT+="$line"$'\n'
    fi
done <<< "$OUTPUT"

# Send directly via message send (only if we have content)
TEXT_OUTPUT=$(echo "$TEXT_OUTPUT" | sed '/^$/d')  # Remove empty lines
if [ -n "$TEXT_OUTPUT" ] && [ ${#TEXT_OUTPUT} -gt 1 ]; then
    if [ -n "$MEDIA_PATH" ] && [ -f "$MEDIA_PATH" ]; then
        "$MOLTBOT" message send --channel telegram --account steve --target 1191367022 --message "$TEXT_OUTPUT" --media "$MEDIA_PATH" 2>&1
    else
        "$MOLTBOT" message send --channel telegram --account steve --target 1191367022 --message "$TEXT_OUTPUT" 2>&1
    fi
else
    echo "⚠️ daily-recap produced no output (quiet day or no memory file)"
fi
