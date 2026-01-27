#!/bin/bash
# System cron wrapper for steve-email-check
# Schedule: hourly (0 * * * *)

# Ensure gateway is running
source /Users/steve/clawd/personal-scripts/cron-wrappers/ensure-gateway.sh
ensure_gateway

SCRIPT="/Users/steve/clawd/personal-scripts/check-email-steve.sh"
MOLTBOT="/Users/steve/Library/pnpm/moltbot"

# Run the actual script
OUTPUT=$("$SCRIPT" 2>&1) || true

# Only notify if there's meaningful output (skip empty/no-mail responses)
if [ -n "$OUTPUT" ] && ! echo "$OUTPUT" | grep -qi "no new\|no unread\|empty"; then
    "$MOLTBOT" agent --agent main --message "Use the message tool to send this to Telegram chat 1191367022 via account steve:

$OUTPUT" 2>&1
fi
