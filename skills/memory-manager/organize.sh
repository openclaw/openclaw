#!/bin/bash
# Organize - Migrate flat files to semantic/procedural/episodic structure

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"
STATE_FILE="$MEMORY_DIR/.memory-manager-state.json"

echo "🗂️  Memory Organizer"
echo ""

# Initialize if needed
if [ ! -f "$STATE_FILE" ]; then
  ~/.openclaw/skills/memory-manager/init.sh
fi

# Find flat files (not in subdirectories)
FLAT_FILES=$(find "$MEMORY_DIR" -maxdepth 1 -name "*.md" -type f 2>/dev/null)

if [ -z "$FLAT_FILES" ]; then
  echo "✅ No flat files to organize."
  echo ""
  echo "Memory structure already clean:"
  echo "  - Episodic: $(ls "$MEMORY_DIR/episodic"/*.md 2>/dev/null | wc -l | tr -d ' ') entries"
  echo "  - Semantic: $(ls "$MEMORY_DIR/semantic"/*.md 2>/dev/null | wc -l | tr -d ' ') topics"
  echo "  - Procedural: $(ls "$MEMORY_DIR/procedural"/*.md 2>/dev/null | wc -l | tr -d ' ') workflows"
  exit 0
fi

echo "Found $(echo "$FLAT_FILES" | wc -l | tr -d ' ') flat files to organize."
echo ""

# Backup first
mkdir -p "$MEMORY_DIR/legacy"
echo "Creating backup in memory/legacy/..."

for file in $FLAT_FILES; do
  filename=$(basename "$file")
  
  # Skip special files
  if [[ "$filename" == "MEMORY.md" ]] || [[ "$filename" == "README.md" ]]; then
    continue
  fi
  
  # Check if it's a date-based file (episodic)
  if [[ "$filename" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$ ]]; then
    # Move to episodic
    mv "$file" "$MEMORY_DIR/episodic/"
    echo "  → Episodic: $filename"
  else
    # Copy to legacy for manual review
    cp "$file" "$MEMORY_DIR/legacy/"
    echo "  → Legacy (review): $filename"
    echo "     Manual categorization needed. Use:"
    echo "     categorize.sh semantic|procedural|episodic \"$filename\""
    echo ""
  fi
done

# Update state
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if command -v jq >/dev/null 2>&1; then
  jq --arg ts "$timestamp" '.last_organize = $ts' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
fi

echo ""
echo "✅ Organization complete!"
echo ""
echo "Next steps:"
echo "  1. Review files in memory/legacy/"
echo "  2. Use categorize.sh to move them properly"
echo "  3. Run detect.sh to check new usage"
echo ""
echo "Example categorization:"
echo "  ~/.openclaw/skills/memory-manager/categorize.sh semantic moltbook memory/legacy/moltbook-notes.md"
