#!/bin/bash
# launch-visible.sh
# Wraps a command in a screen session and auto-launches a watching Terminal.
# Usage: ./launch-visible.sh <workdir> <command> [session_name_prefix]

WORKDIR="${1:-$(pwd)}"
COMMAND="${2:-}"
PREFIX="${3:-coding-agent}"

if [ -z "$COMMAND" ]; then
  echo "Usage: $0 <workdir> <command> [session_name_prefix]"
  exit 1
fi

SESSION_NAME="${PREFIX}-$(date +%s)"

# 1. Start headless screen session with logging enabled
# -L turns on logging (defaults to screenlog.n in current dir on macOS)
# We run bash -c to execute the command and then drop to shell so it doesn't close immediately
screen -L -dmS "$SESSION_NAME" bash -c "cd \"$WORKDIR\" && $COMMAND; exec bash"

# 2. Wait for session to initialize
sleep 1

# 3. Use AppleScript to open a new Terminal window attached to this session
# We use 'screen -x' to attach to the existing session (multi-display mode)
osascript -e "tell application \"Terminal\" to do script \"screen -x $SESSION_NAME\"" >/dev/null

# 4. Output the session details for OpenClaw/User to track
echo "Started visible session: $SESSION_NAME"
echo "To attach manually: screen -x $SESSION_NAME"
