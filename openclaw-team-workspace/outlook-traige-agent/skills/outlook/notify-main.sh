#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
MESSAGE="$1"

CONFIG="$HOME/.openclaw/openclaw.json"
SESSIONS="$HOME/.openclaw/agents/main/sessions/sessions.json"

# Read hook token
HOOK_TOKEN=$(cat "$CONFIG" | jq -r '.hooks.token')

# Gateway URL
GATEWAY_BIND=$(cat "$CONFIG" | jq -r '.gateway.bind // "loopback"')
GATEWAY_PORT=$(cat "$CONFIG" | jq -r '.gateway.port // "18789"')
if [ "$GATEWAY_BIND" = "loopback" ] || [ "$GATEWAY_BIND" = "localhost" ]; then
    GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
else
    GATEWAY_URL="http://${GATEWAY_BIND}:${GATEWAY_PORT}"
fi

# Find active telegram session
SESSION_KEY=$(jq -r 'to_entries[] | select(.key | test("agent:main:telegram:direct:")) | .key' "$SESSIONS" | head -1)
TELEGRAM_ID=$(echo "$SESSION_KEY" | grep -oP 'direct:\K[0-9]+')
AGENT_ID=$(echo "$SESSION_KEY" | cut -d: -f2)

curl -s -X POST "$GATEWAY_URL/hooks/agent" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg msg "$MESSAGE" \
    --arg key "$SESSION_KEY" \
    --arg to "$TELEGRAM_ID" \
    --arg agent "$AGENT_ID" \
    '{"message": $msg, "agentId": $agent, "sessionKey": $key, "deliver": true, "channel": "telegram", "to": $to}')"