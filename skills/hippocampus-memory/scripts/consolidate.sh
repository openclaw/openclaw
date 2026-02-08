#!/bin/bash
# Memory consolidation helper
# Reviews recent daily notes and suggests what to consolidate
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"

echo "🧠 Memory Consolidation"
echo "======================="
echo ""

# Find daily notes from the past week
echo "📅 Recent daily notes:"
find "$MEMORY_DIR" -maxdepth 1 -name "202*.md" -mtime -7 -exec basename {} \; | sort -r

echo ""
echo "---"
echo ""
echo "Consolidation checklist:"
echo ""
echo "1. Review each daily note for:"
echo "   - [User] facts → memory/user/*.md"
echo "   - [Self] insights → memory/self/*.md"
echo "   - [Relationship] moments → memory/relationship/*.md"
echo "   - [World] knowledge → memory/world/*.md"
echo ""
echo "2. Update MEMORY.md with distilled insights"
echo ""
echo "3. Check for outdated information to archive"
echo ""
echo "4. Look for patterns across days"
echo ""
echo "Files to update:"
echo "  - $WORKSPACE/MEMORY.md (long-term)"
echo "  - $MEMORY_DIR/user/*.md"
echo "  - $MEMORY_DIR/self/*.md"  
echo "  - $MEMORY_DIR/relationship/*.md"
echo "  - $MEMORY_DIR/world/*.md"
