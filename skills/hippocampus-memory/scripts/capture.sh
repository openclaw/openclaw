#!/bin/bash
# Memory capture helper - shows what to capture and where
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
MEMORY_DIR="$WORKSPACE/memory"

echo "🧠 Memory Capture"
echo "================"
echo ""
echo "Current date: $(date +%Y-%m-%d)"
echo "Memory dir: $MEMORY_DIR"
echo ""
echo "Today's file: $MEMORY_DIR/$(date +%Y-%m-%d).md"
echo ""
echo "Domains:"
echo "  - user/      → Facts about the user"
echo "  - self/      → Facts about the agent"
echo "  - relationship/ → Shared context"
echo "  - world/     → External knowledge"
echo ""
echo "Trigger phrases to capture:"
echo "  - 'remember that...'"
echo "  - 'I prefer...', 'I always...'"
echo "  - Emotional content"
echo "  - Decisions made"
