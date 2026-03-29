#!/bin/bash
# OpenClaw Agent Wrapper - Works around CLI output bug
# Captures agent response from gateway logs instead of stdout

set -e

OPENCLAW_DIR="${HOME}/GitHub/marcdhansen/openclaw"
LOG_FILE="${HOME}/.openclaw/logs/gateway.log"
GATEWAY_PORT=18789

# Cleanup function
cleanup() {
    rm -f /tmp/openclaw_wrapper_marker.$$ /tmp/openclaw_wrapper_output.$$
}
trap cleanup EXIT

# Ensure gateway is running
if ! curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
    echo "Starting OpenClaw gateway..."
    cd "$OPENCLAW_DIR"
    nohup npx openclaw gateway > /tmp/openclaw_gateway.log 2>&1 &
    sleep 5
    
    if ! curl -s "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
        echo "Error: Failed to start gateway" >&2
        exit 1
    fi
fi

# Clean session locks
rm -f "${HOME}"/.openclaw/agents/*/sessions/*.lock 2>/dev/null || true

# Get last line count before sending message
LAST_LINES=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")

# Send message to agent (runs in background, output goes to logs)
cd "$OPENCLAW_DIR"
npx openclaw agent --agent main --message "$1" >/dev/null 2>&1 &
AGENT_PID=$!

# Wait for response (poll logs)
WAIT_COUNT=0
MAX_WAIT=60
RESPONSE_FOUND=false

while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
    
    # Check if agent process is still running
    if ! kill -0 $AGENT_PID 2>/dev/null; then
        # Agent finished - extract response from logs
        NEW_LINES=$(tail -n +$((LAST_LINES + 1)) "$LOG_FILE" 2>/dev/null || echo "")
        
        # Extract the actual response (skip log prefixes)
        RESPONSE=$(echo "$NEW_LINES" | grep -v "^20.*\[ws\]" | grep -v "^20.*\[gateway\]" | grep -v "^20.*\[heartbeat\]" | grep -v "^20.*\[reload\]" | grep -v "^20.*\[canvas\]" | grep -v "^20.*\[browser\]" | grep -v "^20.*\[health-monitor\]" | grep -v "^$" | tail -50 || true)
        
        if [ -n "$RESPONSE" ]; then
            echo "$RESPONSE"
            RESPONSE_FOUND=true
            break
        fi
    fi
done

if [ "$RESPONSE_FOUND" = "false" ]; then
    echo "Error: No response received within ${MAX_WAIT}s" >&2
    exit 1
fi

# Kill agent process if still running
kill $AGENT_PID 2>/dev/null || true

exit 0
