#!/bin/bash
# Memory Stats - Professional memory architecture statistics

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"
STATE_FILE="$MEMORY_DIR/.memory-manager-state.json"

echo "📊 Memory Manager - Statistics"
echo ""

# Count files and sizes by type
count_stats() {
  local dir="$1"
  local count=$(ls "$dir"/*.md 2>/dev/null | wc -l | tr -d ' ')
  local size=$(du -sh "$dir" 2>/dev/null | cut -f1)
  echo "$count|$size"
}

episodic_stats=$(count_stats "$MEMORY_DIR/episodic")
semantic_stats=$(count_stats "$MEMORY_DIR/semantic")
procedural_stats=$(count_stats "$MEMORY_DIR/procedural")
snapshots_stats=$(count_stats "$MEMORY_DIR/snapshots")

episodic_count=$(echo "$episodic_stats" | cut -d'|' -f1)
episodic_size=$(echo "$episodic_stats" | cut -d'|' -f2)

semantic_count=$(echo "$semantic_stats" | cut -d'|' -f1)
semantic_size=$(echo "$semantic_stats" | cut -d'|' -f2)

procedural_count=$(echo "$procedural_stats" | cut -d'|' -f1)
procedural_size=$(echo "$procedural_stats" | cut -d'|' -f2)

snapshots_count=$(echo "$snapshots_stats" | cut -d'|' -f1)
snapshots_size=$(echo "$snapshots_stats" | cut -d'|' -f2)

# Display breakdown
echo "## Memory Architecture Breakdown"
echo ""
echo "📅 Episodic Memory (What Happened):"
echo "   Files: $episodic_count"
echo "   Size: ${episodic_size:-0B}"
echo ""
echo "🧠 Semantic Memory (What You Know):"
echo "   Files: $semantic_count"
echo "   Size: ${semantic_size:-0B}"
echo ""
echo "⚙️  Procedural Memory (How To):"
echo "   Files: $procedural_count"
echo "   Size: ${procedural_size:-0B}"
echo ""
echo "💾 Snapshots (Backups):"
echo "   Files: $snapshots_count"
echo "   Size: ${snapshots_size:-0B}"
echo ""

# Total
total_files=$((episodic_count + semantic_count + procedural_count))
total_size=$(du -sh "$MEMORY_DIR" 2>/dev/null | cut -f1)

echo "📦 Total:"
echo "   Files: $total_files"
echo "   Size: ${total_size:-0B}"
echo ""

# Compression events
if [ -f "$STATE_FILE" ] && command -v jq >/dev/null 2>&1; then
  warnings=$(jq -r '.warnings // 0' "$STATE_FILE")
  last_check=$(jq -r '.last_check // "never"' "$STATE_FILE")
  last_snapshot=$(jq -r '.last_snapshot // "never"' "$STATE_FILE")
  last_organize=$(jq -r '.last_organize // "never"' "$STATE_FILE")
  
  echo "## Activity"
  echo ""
  echo "Compression events: $warnings"
  echo "Last check: $last_check"
  echo "Last snapshot: $last_snapshot"
  echo "Last organize: $last_organize"
  echo ""
fi

# Growth rate (episodic entries in last 7 days)
recent_episodic=$(find "$MEMORY_DIR/episodic" -name "*.md" -mtime -7 2>/dev/null | wc -l | tr -d ' ')
echo "## Growth"
echo ""
echo "Episodic entries (last 7 days): $recent_episodic"
echo "Average: $((recent_episodic / 7)) entries/day"
echo ""

# Health check
total_chars=0
for dir in episodic semantic procedural; do
  chars=$(find "$MEMORY_DIR/$dir" -name "*.md" -exec wc -c {} + 2>/dev/null | tail -1 | awk '{print $1}' || echo 0)
  total_chars=$((total_chars + chars))
done

usage_pct=$((total_chars * 100 / 800000))

echo "## Memory Health"
echo ""
if [ "$usage_pct" -ge 85 ]; then
  echo "Status: 🚨 CRITICAL (${usage_pct}%)"
  echo "Action: Run organize.sh and snapshot.sh NOW"
elif [ "$usage_pct" -ge 70 ]; then
  echo "Status: ⚠️ WARNING (${usage_pct}%)"
  echo "Action: Consider running organize.sh"
else
  echo "Status: ✅ Healthy (${usage_pct}%)"
  echo "Action: None needed"
fi
