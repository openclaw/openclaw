#!/bin/bash
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$HOME/.openclaw/openclaw.json"
LOG="$SCRIPT_DIR/outlook-hook.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

if [ ! -f "$CONFIG" ]; then
    log "config not found: $CONFIG"
    exit 1
fi

HOOK_TOKEN="$(jq -r '.hooks.token // empty' "$CONFIG")"
if [ -z "$HOOK_TOKEN" ] || [ "$HOOK_TOKEN" = "null" ]; then
    log "hooks.token missing from $CONFIG"
    exit 1
fi

GATEWAY_BIND="$(jq -r '.gateway.bind // .bind // "loopback"' "$CONFIG")"
GATEWAY_PORT="$(jq -r '.gateway.port // .port // empty' "$CONFIG")"

if [ -z "$GATEWAY_PORT" ] || [ "$GATEWAY_PORT" = "null" ]; then
    GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
fi

if [ "$GATEWAY_BIND" = "loopback" ] || [ "$GATEWAY_BIND" = "localhost" ]; then
    GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
else
    GATEWAY_URL="http://${GATEWAY_BIND}:${GATEWAY_PORT}"
fi

if ! curl -sS --max-time 3 "$GATEWAY_URL/healthz" >/dev/null 2>&1; then
    log "gateway not reachable: $GATEWAY_URL"
    exit 1
fi

# Refresh Outlook token before checking mail.
if ! "$SCRIPT_DIR/outlook-token.sh" refresh > /dev/null 2>&1; then
    log "token refresh failed"
    exit 1
fi

# Get new unseen emails.
NEW="$("$SCRIPT_DIR/outlook-seen.sh" filter-new 20 2>/dev/null || true)"

if [ -z "$NEW" ] || [ "$NEW" = '{"new_emails": 0}' ]; then
    log "no new emails, exiting"
    exit 0
fi

IDS="$(echo "$NEW" | jq -r '.id // empty' | tr '\n' ' ')"

if [ -z "$(printf '%s' "$IDS" | xargs)" ]; then
    log "no valid email IDs found in NEW payload; exiting"
    exit 1
fi

EMAIL_DATA="$(echo "$NEW" | jq -c '.' | tr '\n' ' ')"

PAYLOAD="$(jq -n \
    --arg msg "New emails to triage: $EMAIL_DATA — For each: read the full email using outlook-mail.sh, classify importance, and if important send a notification to agent main using notify-main.sh." \
    --arg agent "outlook-triage-agent" \
    '{
        message: $msg,
        agentId: $agent,
        deliver: false
    }')"

CURL_RESULT="$(curl -sS -w "\n%{http_code}" -X POST "$GATEWAY_URL/hooks/agent" \
    -H "Authorization: Bearer $HOOK_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>&1)"

HTTP_CODE="$(printf '%s\n' "$CURL_RESULT" | tail -1)"
BODY="$(printf '%s\n' "$CURL_RESULT" | sed '$d')"

log "hook HTTP=$HTTP_CODE body=$BODY"

# Only mark seen if the triage agent was successfully triggered.
if { [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; } && echo "$BODY" | jq -e '.ok == true' >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    "$SCRIPT_DIR/outlook-seen.sh" add $IDS
    log "agent triggered, emails marked seen"
else
    log "agent trigger failed, emails NOT marked seen"
    exit 1
fi