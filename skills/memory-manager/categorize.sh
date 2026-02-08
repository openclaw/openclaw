#!/bin/bash
# Categorize - Manually categorize a memory file

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"

# Usage
if [ $# -lt 3 ]; then
  echo "Usage: categorize.sh <type> <name> <source-file>"
  echo ""
  echo "Types:"
  echo "  episodic   - Time-based events (use YYYY-MM-DD format for name)"
  echo "  semantic   - Facts/knowledge (use topic name)"
  echo "  procedural - Workflows/processes (use process name)"
  echo ""
  echo "Examples:"
  echo "  categorize.sh episodic 2026-01-31 memory/legacy/today.md"
  echo "  categorize.sh semantic moltbook memory/legacy/moltbook-notes.md"
  echo "  categorize.sh procedural skill-launch memory/legacy/launch-process.md"
  exit 1
fi

TYPE="$1"
NAME="$2"
SOURCE="$3"

# Validate source file exists
if [ ! -f "$SOURCE" ]; then
  echo "❌ Source file not found: $SOURCE"
  exit 1
fi

# Determine destination
case "$TYPE" in
  episodic)
    DEST="$MEMORY_DIR/episodic/${NAME}.md"
    ;;
  semantic)
    DEST="$MEMORY_DIR/semantic/${NAME}.md"
    ;;
  procedural)
    DEST="$MEMORY_DIR/procedural/${NAME}.md"
    ;;
  *)
    echo "❌ Unknown type: $TYPE"
    echo "Valid types: episodic, semantic, procedural"
    exit 1
    ;;
esac

# Check if destination exists
if [ -f "$DEST" ]; then
  echo "⚠️  File already exists: $DEST"
  echo ""
  read -p "Merge with existing file? (y/n) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Append to existing
    echo "" >> "$DEST"
    echo "---" >> "$DEST"
    echo "# Merged from: $(basename "$SOURCE")" >> "$DEST"
    echo "# Date: $(date +"%Y-%m-%d %H:%M:%S")" >> "$DEST"
    echo "" >> "$DEST"
    cat "$SOURCE" >> "$DEST"
    echo "✅ Merged into: $DEST"
  else
    echo "❌ Cancelled"
    exit 1
  fi
else
  # Move to destination
  mv "$SOURCE" "$DEST"
  echo "✅ Categorized as $TYPE: $DEST"
fi

echo ""
echo "Memory organized:"
echo "  Type: $TYPE"
echo "  Name: $NAME"
echo "  Location: $DEST"
