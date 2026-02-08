#!/bin/bash
# Memory Search - search by memory type (episodic/semantic/procedural/all)

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"

# Usage
if [ $# -lt 2 ]; then
  echo "Usage: search.sh <type> <query>"
  echo ""
  echo "Types:"
  echo "  episodic   - Search what happened (time-based events)"
  echo "  semantic   - Search what you know (facts, knowledge)"
  echo "  procedural - Search how to do things (workflows)"
  echo "  all        - Search everything"
  echo ""
  echo "Examples:"
  echo "  search.sh episodic \"launched skill\""
  echo "  search.sh semantic \"moltbook\""
  echo "  search.sh procedural \"validation\""
  echo "  search.sh all \"compression\""
  exit 1
fi

TYPE="$1"
shift
QUERY="$*"

echo "🔍 Memory Search"
echo "Type: $TYPE | Query: \"$QUERY\""
echo ""

# Search function
search_in_dir() {
  local dir="$1"
  local label="$2"
  
  local results=$(grep -i -n -C 2 "$QUERY" "$dir"/*.md 2>/dev/null | head -20)
  
  if [ -n "$results" ]; then
    echo "## $label"
    echo "$results"
    echo ""
  fi
}

# Search based on type
case "$TYPE" in
  episodic)
    search_in_dir "$MEMORY_DIR/episodic" "Episodic Memory (What Happened)"
    ;;
  semantic)
    search_in_dir "$MEMORY_DIR/semantic" "Semantic Memory (What You Know)"
    ;;
  procedural)
    search_in_dir "$MEMORY_DIR/procedural" "Procedural Memory (How To)"
    ;;
  all)
    search_in_dir "$MEMORY_DIR/episodic" "Episodic Memory"
    search_in_dir "$MEMORY_DIR/semantic" "Semantic Memory"
    search_in_dir "$MEMORY_DIR/procedural" "Procedural Memory"
    search_in_dir "$MEMORY_DIR/snapshots" "Snapshots"
    ;;
  *)
    echo "❌ Unknown type: $TYPE"
    echo ""
    echo "Valid types: episodic, semantic, procedural, all"
    exit 1
    ;;
esac

echo "💡 Tip: Use memory_get tool to read full context from specific files"
