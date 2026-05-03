#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_TOKEN=$(cat "$HOME/.openclaw/openclaw.json" | jq -r '.hooks.token')
LOG="$(dirname "$(readlink -f "$0")")/outlook-hook.log"
# Refresh token
"$SCRIPT_DIR/outlook-token.sh" refresh > /dev/null 2>&1
# Get new unseen emails
NEW=$("$SCRIPT_DIR/outlook-seen.sh" filter-new 2>/dev/null)
if [ -z "$NEW" ] || [ "$NEW" = '{"new_emails": 0}' ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] no new emails, exiting" >> "$LOG"
    exit 0
fi
IDS=$(echo "$NEW" | jq -r '.id // empty' | tr '\n' ' ')
EMAIL_DATA=$(echo "$NEW" | jq -c '.' | tr '\n' ' ')
PAYLOAD=$(jq -n \
    --arg msg "New emails to triage: $EMAIL_DATA — For each: read the full email using outlook-mail.sh, classify importance, if important send a notification to agent main using notify-main.sh." \
    --arg agent "outlook-triage-agent" \
    '{"message": $msg, "agentId": $agent, "deliver": false}')
CURL_RESULT=$(curl -s -X POST http://127.0.0.1:18789/hooks/agent \
    -H "Authorization: Bearer $HOOK_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")
echo "[$(date '+%Y-%m-%d %H:%M:%S')] curl result: $CURL_RESULT" >> "$LOG"
# Only mark seen if agent was successfully triggered
if echo "$CURL_RESULT" | jq -e '.ok == true' > /dev/null 2>&1; then
    "$SCRIPT_DIR/outlook-seen.sh" add $IDS
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] agent triggered, emails marked seen" >> "$LOG"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] agent trigger failed, emails NOT marked seen" >> "$LOG"
fi