#!/bin/bash
# Snapshot - Save memory state before compression

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"
SNAPSHOT_DIR="$MEMORY_DIR/snapshots"
STATE_FILE="$MEMORY_DIR/.memory-manager-state.json"

# Create snapshot directory
mkdir -p "$SNAPSHOT_DIR"

# Generate snapshot filename
SNAPSHOT_FILE="$SNAPSHOT_DIR/$(date +%Y-%m-%d-%H%M).md"

echo "💾 Creating memory snapshot..."
echo ""

# Create snapshot header
cat > "$SNAPSHOT_FILE" << EOF
# Memory Snapshot - $(date +"%Y-%m-%d %H:%M:%S")

**Auto-saved before compression event**

---

EOF

# Capture episodic (recent events)
echo "## Recent Events (Episodic)" >> "$SNAPSHOT_FILE"
echo "" >> "$SNAPSHOT_FILE"

recent_episodic=$(find "$MEMORY_DIR/episodic" -name "*.md" -mtime -3 | sort -r | head -3)
if [ -n "$recent_episodic" ]; then
  for file in $recent_episodic; do
    echo "### $(basename "$file" .md)" >> "$SNAPSHOT_FILE"
    tail -n 30 "$file" >> "$SNAPSHOT_FILE"
    echo "" >> "$SNAPSHOT_FILE"
  done
else
  echo "*No recent episodic entries*" >> "$SNAPSHOT_FILE"
  echo "" >> "$SNAPSHOT_FILE"
fi

# Capture semantic (key knowledge)
echo "## Key Knowledge (Semantic)" >> "$SNAPSHOT_FILE"
echo "" >> "$SNAPSHOT_FILE"

semantic_files=$(find "$MEMORY_DIR/semantic" -name "*.md" | head -5)
if [ -n "$semantic_files" ]; then
  for file in $semantic_files; do
    echo "### $(basename "$file" .md)" >> "$SNAPSHOT_FILE"
    head -n 20 "$file" >> "$SNAPSHOT_FILE"
    echo "" >> "$SNAPSHOT_FILE"
  done
else
  echo "*No semantic entries*" >> "$SNAPSHOT_FILE"
  echo "" >> "$SNAPSHOT_FILE"
fi

# Capture procedural (important workflows)
echo "## Key Workflows (Procedural)" >> "$SNAPSHOT_FILE"
echo "" >> "$SNAPSHOT_FILE"

procedural_files=$(find "$MEMORY_DIR/procedural" -name "*.md" | head -3)
if [ -n "$procedural_files" ]; then
  for file in $procedural_files; do
    echo "### $(basename "$file" .md)" >> "$SNAPSHOT_FILE"
    head -n 20 "$file" >> "$SNAPSHOT_FILE"
    echo "" >> "$SNAPSHOT_FILE"
  done
else
  echo "*No procedural entries*" >> "$SNAPSHOT_FILE"
  echo "" >> "$SNAPSHOT_FILE"
fi

# Add metadata
cat >> "$SNAPSHOT_FILE" << EOF

---

**Snapshot metadata:**
- Created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- Trigger: Compression detection
- Coverage: Last 3 days episodic + top 5 semantic + top 3 procedural
- Purpose: Recovery checkpoint before potential memory loss
EOF

# Update state
if command -v jq >/dev/null 2>&1; then
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  jq --arg ts "$timestamp" '.last_snapshot = $ts | .warnings += 1' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
fi

echo "✅ Snapshot saved: $SNAPSHOT_FILE"
echo ""
echo "Snapshot includes:"
echo "  - Last 3 days episodic entries"
echo "  - Top 5 semantic knowledge files"
echo "  - Top 3 procedural workflows"
echo ""
echo "Next steps:"
echo "  1. Review snapshot for completeness"
echo "  2. Run: organize.sh (reduce memory usage)"
echo "  3. Consider pruning old episodic entries"
