#!/bin/bash
# File-based memory search - wraps clawdbot memory search

QUERY="$1"
LIMIT="${2:-5}"
TMPFILE="/tmp/clawdbot-filesearch.txt"

if [ -z "$QUERY" ]; then
  echo "Usage: file-search.sh <query> [limit]"
  exit 1
fi

rm -f "$TMPFILE"

# Run search in background (--max-results is the correct flag)
clawdbot memory search "$QUERY" --max-results "$LIMIT" > "$TMPFILE" 2>&1 &
SEARCH_PID=$!
sleep 8
kill $SEARCH_PID 2>/dev/null
wait $SEARCH_PID 2>/dev/null

# Extract score lines (format: 0.xxx filepath:lines)
grep -E "^[0-9]\.[0-9]+" "$TMPFILE" || echo "No results"
