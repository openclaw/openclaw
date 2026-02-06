#!/bin/bash
# ChatGPT Conversation Exporter
# Usage: ./export.sh <access_token> [output_dir]

set -e

TOKEN="$1"
OUTPUT_DIR="${2:-$HOME/.openclaw/workspace/chatgpt-export/$(date +%Y-%m-%d)}"

if [ -z "$TOKEN" ]; then
  echo "Usage: ./export.sh <access_token> [output_dir]"
  echo ""
  echo "Get your access token by running this in browser console on chatgpt.com:"
  echo "  fetch('/api/auth/session').then(r=>r.json()).then(d=>console.log(d.accessToken))"
  exit 1
fi

mkdir -p "$OUTPUT_DIR/conversations"
echo "📁 Output directory: $OUTPUT_DIR"

# Fetch conversation list
echo "📋 Fetching conversation list..."
OFFSET=0
LIMIT=100
ALL_IDS=""

while true; do
  RESP=$(curl -s "https://chatgpt.com/backend-api/conversations?offset=$OFFSET&limit=$LIMIT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json")
  
  # Extract IDs and titles
  COUNT=$(echo "$RESP" | jq '.items | length')
  
  if [ "$OFFSET" -eq 0 ]; then
    echo "$RESP" | jq '.items' > "$OUTPUT_DIR/index.json"
    TOTAL=$(echo "$RESP" | jq '.total // .items | length')
    echo "📊 Found $TOTAL conversations"
  else
    # Append to index
    jq -s '.[0] + .[1]' "$OUTPUT_DIR/index.json" <(echo "$RESP" | jq '.items') > "$OUTPUT_DIR/index.tmp.json"
    mv "$OUTPUT_DIR/index.tmp.json" "$OUTPUT_DIR/index.json"
  fi
  
  # Add IDs to list
  IDS=$(echo "$RESP" | jq -r '.items[].id')
  ALL_IDS="$ALL_IDS $IDS"
  
  if [ "$COUNT" -lt "$LIMIT" ]; then
    break
  fi
  
  OFFSET=$((OFFSET + LIMIT))
  sleep 0.2
done

# Count total
TOTAL_IDS=$(echo "$ALL_IDS" | wc -w)
echo "📥 Fetching $TOTAL_IDS conversations..."

# Fetch each conversation
EXPORTED=0
ERRORS=0

for ID in $ALL_IDS; do
  EXPORTED=$((EXPORTED + 1))
  
  # Get conversation
  CONV=$(curl -s "https://chatgpt.com/backend-api/conversation/$ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json")
  
  # Check for error
  if echo "$CONV" | jq -e '.detail' > /dev/null 2>&1; then
    echo "❌ [$EXPORTED/$TOTAL_IDS] Error fetching $ID"
    ERRORS=$((ERRORS + 1))
    continue
  fi
  
  TITLE=$(echo "$CONV" | jq -r '.title // "Untitled"')
  SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | cut -c1-50)
  
  # Save JSON
  echo "$CONV" > "$OUTPUT_DIR/conversations/${ID}.json"
  
  # Convert to Markdown
  {
    echo "# $TITLE"
    echo ""
    echo "**ID:** $ID"
    echo "**Created:** $(echo "$CONV" | jq -r '.create_time')"
    echo ""
    echo "---"
    echo ""
    
    # Extract messages (simplified - just text parts)
    echo "$CONV" | jq -r '
      .mapping | to_entries[] | 
      select(.value.message.content.parts != null) |
      select(.value.message.author.role != "system") |
      {
        role: .value.message.author.role,
        content: (.value.message.content.parts | map(select(type == "string")) | join("\n")),
        time: .value.message.create_time
      } |
      select(.content != "")
    ' | jq -s 'sort_by(.time)' | jq -r '.[] | 
      if .role == "user" then "## You\n\n\(.content)\n\n---\n" 
      else "## ChatGPT\n\n\(.content)\n\n---\n" end'
  } > "$OUTPUT_DIR/conversations/${ID}_${SLUG}.md"
  
  printf "✅ [%d/%d] %s\r" "$EXPORTED" "$TOTAL_IDS" "$TITLE"
  
  # Rate limit
  sleep 0.1
done

echo ""
echo ""
echo "🎉 Export complete!"
echo "   📁 $OUTPUT_DIR"
echo "   ✅ Exported: $((EXPORTED - ERRORS))"
echo "   ❌ Errors: $ERRORS"
