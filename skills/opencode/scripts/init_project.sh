#!/bin/bash
# OpenCode Project Initialization Script
# Creates a new OpenCode session for a project

if [ -z "$1" ]; then
    echo "Usage: $0 <project-name>"
    echo "Example: $0 \"Todo App\""
    exit 1
fi

PROJECT_NAME="$1"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed. Install with: sudo apt-get install jq"
    exit 1
fi

# Check if OpenCode server is running
SERVER_HEALTH=$(curl -s -f http://localhost:4096/global/health 2>/dev/null)
if [ $? -ne 0 ]; then
    echo "Error: OpenCode server not running at http://localhost:4096"
    echo "Start server with: opencode serve --port 4096 --hostname 127.0.0.1"
    exit 1
fi

# Create new session
SESSION_RESPONSE=$(curl -s -X POST http://localhost:4096/session \
  -H "Content-Type: application/json" \
  -d "{\"title\": \"Project: $PROJECT_NAME\"}")

SESSION_ID=$(echo "$SESSION_RESPONSE" | jq -r '.id')

if [ "$SESSION_ID" = "null" ] || [ -z "$SESSION_ID" ]; then
    echo "Error: Failed to create session"
    echo "Response: $SESSION_RESPONSE"
    exit 1
fi

# Store session ID
echo "$SESSION_ID" > /tmp/opencode_current_session.txt
echo "Session created: $SESSION_ID"
echo "Project: $PROJECT_NAME"
echo ""
echo "Session ID stored in /tmp/opencode_current_session.txt"
echo ""
echo "Next steps:"
echo "1. Discuss project requirements in detail"
echo "2. Use plan_mode.sh for detailed planning"
echo "3. Use build_mode.sh for implementation"

# Also store project name
echo "$PROJECT_NAME" > /tmp/opencode_current_project.txt