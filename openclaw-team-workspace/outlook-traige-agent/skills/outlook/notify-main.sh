#!/bin/bash
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

MESSAGE="Outlook triage alert: ${1:-}"

if [ -z "$MESSAGE" ]; then
  echo "Usage: notify-main.sh <message>"
  exit 1
fi

CONFIG="$HOME/.openclaw/openclaw.json"
SESSIONS="$HOME/.openclaw/agents/main/sessions/sessions.json"

if [ ! -f "$CONFIG" ]; then
  echo "Error: config not found: $CONFIG"
  exit 1
fi

if [ ! -f "$SESSIONS" ]; then
  echo "Error: sessions file not found: $SESSIONS"
  exit 1
fi

HOOK_TOKEN="$(jq -r '.hooks.token // empty' "$CONFIG")"
GATEWAY_BIND="$(jq -r '.gateway.bind // .bind // "loopback"' "$CONFIG")"
GATEWAY_PORT="$(jq -r '.gateway.port // .port // empty' "$CONFIG")"

if [ -z "$GATEWAY_PORT" ] || [ "$GATEWAY_PORT" = "null" ]; then
  GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
fi

if [ -z "$HOOK_TOKEN" ] || [ "$HOOK_TOKEN" = "null" ]; then
  echo "Error: hooks.token missing from $CONFIG"
  exit 1
fi

if [ "$GATEWAY_BIND" = "loopback" ] || [ "$GATEWAY_BIND" = "localhost" ]; then
  GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
else
  GATEWAY_URL="http://${GATEWAY_BIND}:${GATEWAY_PORT}"
fi

if ! curl -sS --max-time 3 "$GATEWAY_URL/healthz" >/dev/null 2>&1; then
  echo "Error: OpenClaw gateway is not reachable at $GATEWAY_URL"
  echo "Debug:"
  echo "  GATEWAY_BIND=$GATEWAY_BIND"
  echo "  GATEWAY_PORT=$GATEWAY_PORT"
  echo "  CONFIG=$CONFIG"
  exit 1
fi

SESSION_KEYS="$(jq -r 'keys[] | select(startswith("agent:main:"))' "$SESSIONS" | sort -u)"

if [ -z "$SESSION_KEYS" ]; then
  echo "Error: no main-agent sessions found in $SESSIONS"
  exit 1
fi

echo "$SESSION_KEYS" | while IFS= read -r SESSION_KEY; do
  [ -z "$SESSION_KEY" ] && continue

  AGENT_ID="$(printf '%s' "$SESSION_KEY" | cut -d: -f2)"
  CHANNEL="$(printf '%s' "$SESSION_KEY" | cut -d: -f3)"

  if [ "$CHANNEL" = "telegram" ]; then
    case "$SESSION_KEY" in
      *:direct:*)
        TELEGRAM_ID="${SESSION_KEY##*:direct:}"
        ;;
      *)
        TELEGRAM_ID=""
        ;;
    esac

    if [ -z "$TELEGRAM_ID" ]; then
      echo "Skipping malformed Telegram session: $SESSION_KEY"
      continue
    fi

    PAYLOAD="$(jq -n \
      --arg msg "$MESSAGE" \
      --arg key "$SESSION_KEY" \
      --arg agent "$AGENT_ID" \
      --arg to "$TELEGRAM_ID" \
      '{
        message: $msg,
        agentId: $agent,
        sessionKey: $key,
        deliver: true,
        channel: "telegram",
        to: $to
      }')"
  else
    PAYLOAD="$(jq -n \
      --arg msg "$MESSAGE" \
      --arg key "$SESSION_KEY" \
      --arg agent "$AGENT_ID" \
      '{
        message: $msg,
        agentId: $agent,
        sessionKey: $key,
        deliver: true
      }')"
  fi

  RESPONSE="$(curl -sS -w "\n%{http_code}" -X POST "$GATEWAY_URL/hooks/agent" \
    -H "Authorization: Bearer $HOOK_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>&1)"

  HTTP_CODE="$(printf '%s\n' "$RESPONSE" | tail -1)"
  BODY="$(printf '%s\n' "$RESPONSE" | sed '$d')"

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
    echo "Sent to $SESSION_KEY"
  else
    echo "Failed to send to $SESSION_KEY HTTP=$HTTP_CODE"
    [ -n "$BODY" ] && printf '%s\n' "$BODY"
  fi
done