#!/bin/bash
# Preprocess transcript into clean signals for hippocampus
# Extracts just user/assistant text content, strips tool noise
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)
#   AGENT_ID - Agent ID for transcript lookup (default: main)

set -e

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
AGENT_ID="${AGENT_ID:-main}"
TRANSCRIPT_DIR="$HOME/.openclaw/agents/$AGENT_ID/sessions"
OUTPUT="$WORKSPACE/memory/signals.jsonl"
INDEX="$WORKSPACE/memory/index.json"

# Get the current watermark
WATERMARK=$(cat "$INDEX" 2>/dev/null | grep -o '"lastProcessedMessageId": "[^"]*"' | cut -d'"' -f4)

# Find the active session (most recently modified .jsonl)
SESSION_FILE=$(ls -t "$TRANSCRIPT_DIR"/*.jsonl 2>/dev/null | head -1)

if [ -z "$SESSION_FILE" ]; then
    echo "No session transcript found in $TRANSCRIPT_DIR"
    exit 1
fi

echo "Processing: $SESSION_FILE"
echo "Watermark: $WATERMARK"

# Extract messages, find position after watermark, output clean signals
# Only get user messages (where the memorable content lives)
{
    # If we have a watermark, start after it
    if [ -n "$WATERMARK" ]; then
        # Find line number of watermark, then get lines after
        WATERMARK_LINE=$(grep -n "\"id\":\"$WATERMARK\"" "$SESSION_FILE" | head -1 | cut -d: -f1)
        if [ -n "$WATERMARK_LINE" ]; then
            tail -n +$((WATERMARK_LINE + 1)) "$SESSION_FILE"
        else
            # Watermark not found, process last 50 lines
            tail -50 "$SESSION_FILE"
        fi
    else
        # No watermark, process last 50 lines
        tail -50 "$SESSION_FILE"
    fi
} | grep '"type":"message"' | grep '"role":"user"' | while read -r line; do
    # Extract just what we need
    id=$(echo "$line" | jq -r '.id // empty')
    timestamp=$(echo "$line" | jq -r '.timestamp // empty')
    
    # Get the text content - handle both direct text and array format
    text=$(echo "$line" | jq -r '.message.content[0].text // .message.content // empty' 2>/dev/null | head -c 500)
    
    # Skip if it looks like a system message or session result
    if echo "$text" | grep -q '^{'; then
        continue
    fi
    
    # Skip empty or very short messages
    if [ ${#text} -lt 10 ]; then
        continue
    fi
    
    # Output clean signal
    if [ -n "$id" ] && [ -n "$text" ]; then
        echo "{\"id\":\"$id\",\"timestamp\":\"$timestamp\",\"text\":\"$(echo "$text" | sed 's/"/\\"/g' | tr '\n' ' ')\"}"
    fi
done > "$OUTPUT"

# Count results
COUNT=$(wc -l < "$OUTPUT" | tr -d ' ')
echo "Wrote $COUNT signals to $OUTPUT"
