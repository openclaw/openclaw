#!/bin/bash
# OpenCode Plan Mode Script
# Sends a prompt to OpenCode in Plan Mode for detailed planning

if [ -z "$1" ]; then
    echo "Usage: $0 \"<prompt>\""
    echo "Example: $0 \"Create a comprehensive plan for a React Todo app with TypeScript, local storage, and unit tests\""
    exit 1
fi

PROMPT="$1"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed. Install with: sudo apt-get install jq"
    exit 1
fi

# Check for active session
if [ ! -f /tmp/opencode_current_session.txt ]; then
    echo "Error: No active OpenCode session found"
    echo "Run init_project.sh first to create a session"
    exit 1
fi

SESSION_ID=$(cat /tmp/opencode_current_session.txt)
if [ -z "$SESSION_ID" ]; then
    echo "Error: Invalid session ID in /tmp/opencode_current_session.txt"
    exit 1
fi

# Check if OpenCode server is running
SERVER_HEALTH=$(curl -s -f http://localhost:4096/global/health 2>/dev/null)
if [ $? -ne 0 ]; then
    echo "Error: OpenCode server not running at http://localhost:4096"
    echo "Start server with: opencode serve --port 4096 --hostname 127.0.0.1"
    exit 1
fi

# Get project name if available
PROJECT_NAME="Unknown Project"
if [ -f /tmp/opencode_current_project.txt ]; then
    PROJECT_NAME=$(cat /tmp/opencode_current_project.txt)
fi

echo "Sending to Plan Mode..."
echo "Project: $PROJECT_NAME"
echo "Session: $SESSION_ID"
echo "Prompt: $PROMPT"
echo ""

# Send message in Plan Mode
RESPONSE=$(curl -s -X POST "http://localhost:4096/session/$SESSION_ID/message" \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"$PROMPT\",
    \"model\": \"deepseek/deepseek-chat\",
    \"agent\": \"plan\"
  }")

# Check for errors
if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message // .error')
    echo "Error from OpenCode API: $ERROR_MSG"
    exit 1
fi

# Extract and display the response
MESSAGE_ID=$(echo "$RESPONSE" | jq -r '.info.id')
PARTS_COUNT=$(echo "$RESPONSE" | jq '.parts | length')

echo "✓ Plan Mode response received"
echo "Message ID: $MESSAGE_ID"
echo "Response parts: $PARTS_COUNT"
echo ""
echo "--- OpenCode Plan Response ---"

# Display all text parts
for i in $(seq 0 $((PARTS_COUNT - 1))); do
    PART_TYPE=$(echo "$RESPONSE" | jq -r ".parts[$i].type")
    if [ "$PART_TYPE" = "text" ]; then
        CONTENT=$(echo "$RESPONSE" | jq -r ".parts[$i].content")
        echo "$CONTENT"
        echo ""
    fi
done

echo "--- End of Plan Response ---"
echo ""
echo "Next steps:"
echo "1. Review the plan for completeness and adherence to requirements"
echo "2. If plan needs adjustments, run plan_mode.sh again with feedback"
echo "3. Once plan is approved, create testing strategy with plan_mode.sh"
echo "4. Use build_mode.sh for implementation"