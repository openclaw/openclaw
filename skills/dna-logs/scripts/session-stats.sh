#!/bin/bash
# Show session statistics from clawdbot
# Usage: session-stats.sh

SESSIONS_JSON="$HOME/.clawdbot/agents/main/sessions/sessions.json"
SESSION_DIR="$HOME/.clawdbot/agents/main/sessions"

echo "=== Session Statistics ==="
echo ""

if [ -f "$SESSIONS_JSON" ]; then
    echo "Current Session:"
    jq -r '."agent:main:main" | "  ID: \(.sessionId)\n  Model: \(.modelProvider)/\(.model)\n  Total Tokens: \(.totalTokens)\n  Context Window: \(.contextTokens)\n  Compactions: \(.compactionCount)\n  Channel: \(.lastChannel)"' "$SESSIONS_JSON" 2>/dev/null

    echo ""
    echo "Token Usage:"
    TOTAL=$(jq -r '."agent:main:main".totalTokens // 0' "$SESSIONS_JSON" 2>/dev/null)
    CONTEXT=$(jq -r '."agent:main:main".contextTokens // 200000' "$SESSIONS_JSON" 2>/dev/null)
    PERCENT=$((TOTAL * 100 / CONTEXT))
    echo "  Used: $TOTAL / $CONTEXT ($PERCENT%)"

    if [ "$PERCENT" -gt 50 ]; then
        echo "  WARNING: Consider running /compact or starting new session"
    fi
else
    echo "No sessions.json found"
fi

echo ""
echo "=== Session File Stats ==="
CURRENT_SESSION=$(jq -r '."agent:main:main".sessionId // "unknown"' "$SESSIONS_JSON" 2>/dev/null)
SESSION_FILE="$SESSION_DIR/$CURRENT_SESSION.jsonl"

if [ -f "$SESSION_FILE" ]; then
    LINES=$(wc -l < "$SESSION_FILE")
    SIZE=$(du -h "$SESSION_FILE" | cut -f1)
    echo "  File: $SESSION_FILE"
    echo "  Size: $SIZE"
    echo "  Messages: $LINES"

    echo ""
    echo "=== Recent Cost Summary (last 10 API calls) ==="
    tail -50 "$SESSION_FILE" | \
    jq -r 'select(.message.role=="assistant" and .message.usage) |
           "\(.message.usage.totalTokens // 0) tokens, $\(.message.usage.cost.total // 0 | tostring[0:6])"' 2>/dev/null | \
    tail -10
else
    echo "Session file not found"
fi

echo ""
echo "=== Gateway Status ==="
systemctl --user is-active clawdbot-gateway.service 2>/dev/null || echo "unknown"
