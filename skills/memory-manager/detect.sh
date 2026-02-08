#!/bin/bash
# Compression Detection - monitors all memory types

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"
STATE_FILE="$MEMORY_DIR/.memory-manager-state.json"

# Initialize if needed
if [ ! -f "$STATE_FILE" ]; then
  ~/.openclaw/skills/memory-manager/init.sh > /dev/null 2>&1
fi

# Calculate total memory usage across all types
calculate_usage() {
  local total_chars=0
  
  # Episodic memory (last 7 days)
  for file in "$MEMORY_DIR"/episodic/*.md; do
    [ -f "$file" ] && total_chars=$((total_chars + $(wc -c < "$file" 2>/dev/null || echo 0)))
  done
  
  # Semantic memory (all files)
  for file in "$MEMORY_DIR"/semantic/*.md; do
    [ -f "$file" ] && total_chars=$((total_chars + $(wc -c < "$file" 2>/dev/null || echo 0)))
  done
  
  # Procedural memory (all files)
  for file in "$MEMORY_DIR"/procedural/*.md; do
    [ -f "$file" ] && total_chars=$((total_chars + $(wc -c < "$file" 2>/dev/null || echo 0)))
  done
  
  # Legacy flat files (if any)
  for file in "$MEMORY_DIR"/*.md "$MEMORY_DIR"/legacy/*.md; do
    [ -f "$file" ] && total_chars=$((total_chars + $(wc -c < "$file" 2>/dev/null || echo 0)))
  done
  
  # Estimate: 200k tokens ≈ 800k chars (conservative)
  local usage_percent=$((total_chars * 100 / 800000))
  
  echo "$usage_percent"
}

# Get breakdown by type
get_breakdown() {
  local episodic=$(find "$MEMORY_DIR/episodic" -name "*.md" -exec wc -c {} + 2>/dev/null | tail -1 | awk '{print $1}' || echo 0)
  local semantic=$(find "$MEMORY_DIR/semantic" -name "*.md" -exec wc -c {} + 2>/dev/null | tail -1 | awk '{print $1}' || echo 0)
  local procedural=$(find "$MEMORY_DIR/procedural" -name "*.md" -exec wc -c {} + 2>/dev/null | tail -1 | awk '{print $1}' || echo 0)
  
  local total=$((episodic + semantic + procedural))
  [ "$total" -eq 0 ] && total=1  # Avoid division by zero
  
  local episodic_pct=$((episodic * 100 / total))
  local semantic_pct=$((semantic * 100 / total))
  local procedural_pct=$((procedural * 100 / total))
  
  echo "Episodic: ${episodic_pct}% | Semantic: ${semantic_pct}% | Procedural: ${procedural_pct}%"
}

# Check usage
usage=$(calculate_usage)
breakdown=$(get_breakdown)

# Update state
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if command -v jq >/dev/null 2>&1; then
  jq --arg ts "$timestamp" '.last_check = $ts' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
fi

# Output status
echo "🧠 Memory Manager - Compression Check"
echo ""
echo "Total usage: ${usage}%"
echo "Breakdown: $breakdown"
echo ""

if [ "$usage" -ge 85 ]; then
  echo "🚨 CRITICAL: ${usage}% context usage"
  echo ""
  echo "Action needed NOW:"
  echo "  1. Run: ~/.openclaw/skills/memory-manager/snapshot.sh"
  echo "  2. Run: ~/.openclaw/skills/memory-manager/organize.sh"
  echo "  3. Consider pruning episodic entries >30 days old"
  exit 2
elif [ "$usage" -ge 70 ]; then
  echo "⚠️ WARNING: ${usage}% context usage"
  echo ""
  echo "Recommended actions:"
  echo "  1. Run: ~/.openclaw/skills/memory-manager/organize.sh"
  echo "  2. Review semantic/procedural for duplicates"
  echo "  3. Create snapshot if doing complex work"
  exit 1
else
  echo "✅ Safe: ${usage}% context usage"
  echo ""
  echo "Memory health: Good"
  exit 0
fi
