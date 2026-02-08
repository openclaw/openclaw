#!/bin/bash
# Send a message to another agent session via Gateway and wait for the response.
# Uses chat.send so the conversation is visible in webchat.
# Automatically prepends sender identity from OPENCLAW_AGENT_ID env var.
# Usage: session-send.sh <sessionKey> "<message>"
# Example: session-send.sh "agent:developer:main" "Please review the latest changes"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_KEY="$1"
MESSAGE="$2"

if [ -z "$SESSION_KEY" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: session-send.sh <sessionKey> \"<message>\""
  echo "Example: session-send.sh \"agent:developer:main\" \"Hello!\""
  exit 1
fi

# Prepend sender identity if available
if [ -n "$OPENCLAW_AGENT_ID" ]; then
  MESSAGE="[from:${OPENCLAW_AGENT_ID}] ${MESSAGE}"
fi

# Escape message for JSON
MESSAGE_JSON=$(printf '%s' "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

RESPONSE=$(node "$SCRIPT_DIR/gateway-rpc.mjs" chat.send "{\"sessionKey\":\"$SESSION_KEY\",\"message\":$MESSAGE_JSON}")

if [ $? -ne 0 ]; then
  echo "Error sending message to $SESSION_KEY"
  exit 1
fi

if [ -n "$RESPONSE" ]; then
  echo "$RESPONSE"
else
  echo "No response received"
fi
