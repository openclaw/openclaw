#!/usr/bin/env bash
# Initialize the adaptive-memory directory structure in a workspace.
# Usage: ./init_memory.sh [workspace_dir]
#   workspace_dir: path to the workspace root (default: current directory)

set -euo pipefail

WORKSPACE="${1:-.}"

mkdir -p "$WORKSPACE/memory/channel_context"

# active_context.md
if [ ! -f "$WORKSPACE/memory/active_context.md" ]; then
  cat > "$WORKSPACE/memory/active_context.md" << 'EOF'
# Active Context

## In Progress
<!-- Add current tasks here -->

## Blocked / Waiting
<!-- Add blocked items here -->

## Recently Completed
<!-- Move completed items here, prune after a few days -->
EOF
  echo "[OK] Created memory/active_context.md"
else
  echo "[SKIP] memory/active_context.md already exists"
fi

# pending_tasks.json
if [ ! -f "$WORKSPACE/memory/pending_tasks.json" ]; then
  cat > "$WORKSPACE/memory/pending_tasks.json" << 'EOF'
{
  "lastUpdated": "",
  "tasks": []
}
EOF
  echo "[OK] Created memory/pending_tasks.json"
else
  echo "[SKIP] memory/pending_tasks.json already exists"
fi

# heartbeat-state.json
if [ ! -f "$WORKSPACE/memory/heartbeat-state.json" ]; then
  cat > "$WORKSPACE/memory/heartbeat-state.json" << 'EOF'
{
  "lastConsolidatedAt": null
}
EOF
  echo "[OK] Created memory/heartbeat-state.json"
else
  echo "[SKIP] memory/heartbeat-state.json already exists"
fi

# MEMORY.md at workspace root
if [ ! -f "$WORKSPACE/MEMORY.md" ]; then
  cat > "$WORKSPACE/MEMORY.md" << 'EOF'
# Long-Term Memory

*Curated knowledge distilled from daily notes. Updated periodically.*

## Systems Built
<!-- Document systems, tools, and automations you've created -->

## Lessons Learned
<!-- Hard-won knowledge worth remembering -->

## Key Decisions
<!-- Important decisions and their reasoning -->

---
*Last updated: (not yet consolidated)*
EOF
  echo "[OK] Created MEMORY.md"
else
  echo "[SKIP] MEMORY.md already exists"
fi

# Today's daily note
TODAY=$(date +%Y-%m-%d)
if [ ! -f "$WORKSPACE/memory/$TODAY.md" ]; then
  cat > "$WORKSPACE/memory/$TODAY.md" << EOF
# $TODAY

## Tasks

## Decisions

## Learned

## Blockers
EOF
  echo "[OK] Created memory/$TODAY.md"
else
  echo "[SKIP] memory/$TODAY.md already exists"
fi

echo ""
echo "Memory structure initialized in: $WORKSPACE"
echo ""
echo "Directory layout:"
echo "  $WORKSPACE/"
echo "  ├── MEMORY.md"
echo "  └── memory/"
echo "      ├── active_context.md"
echo "      ├── pending_tasks.json"
echo "      ├── heartbeat-state.json"
echo "      ├── channel_context/"
echo "      └── $TODAY.md"
