#!/bin/bash
# View chat history of a session via Gateway.
# Usage: session-history.sh <sessionKey> [limit]
# Example: session-history.sh "agent:developer:main" 10

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_KEY="$1"
LIMIT="${2:-20}"

if [ -z "$SESSION_KEY" ]; then
  echo "Usage: session-history.sh <sessionKey> [limit]"
  echo "Example: session-history.sh \"agent:developer:main\" 10"
  exit 1
fi

node "$SCRIPT_DIR/gateway-rpc.mjs" chat.history "{\"sessionKey\":\"$SESSION_KEY\",\"limit\":$LIMIT}"
