#!/bin/sh
# Blink Connector Call Script
# Usage: call.sh PROVIDER /endpoint HTTP_METHOD [JSON_BODY]
# Example: call.sh notion /search POST '{"query":"meeting notes"}'

PROVIDER="$1"
ENDPOINT="$2"
METHOD="${3:-GET}"
BODY="$4"
BASE_URL="${BLINK_APIS_URL:-https://core.blink.new}"

if [ -n "$BODY" ]; then
  curl -sf -X POST "$BASE_URL/v1/connectors/$PROVIDER/execute" \
    -H "Authorization: Bearer $BLINK_API_KEY" \
    -H "Content-Type: application/json" \
    -H "x-blink-agent-id: $BLINK_AGENT_ID" \
    -d "{\"method\":\"$ENDPOINT\",\"http_method\":\"$METHOD\",\"params\":$BODY}"
else
  curl -sf -X POST "$BASE_URL/v1/connectors/$PROVIDER/execute" \
    -H "Authorization: Bearer $BLINK_API_KEY" \
    -H "Content-Type: application/json" \
    -H "x-blink-agent-id: $BLINK_AGENT_ID" \
    -d "{\"method\":\"$ENDPOINT\",\"http_method\":\"$METHOD\"}"
fi
