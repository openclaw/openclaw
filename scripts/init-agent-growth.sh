#!/usr/bin/env bash
# init-agent-growth.sh — Bootstrap the growth system for an existing agent workspace
#
# Usage:
#   ./scripts/init-agent-growth.sh [WORKSPACE_DIR]
#
# Default WORKSPACE_DIR: ~/.openclaw/workspace
# Reads templates from: docs/reference/templates/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES="$REPO_ROOT/docs/reference/templates"
WORKSPACE="${1:-$HOME/.openclaw/workspace}"

echo "→ Initialising growth system in: $WORKSPACE"

# 1. Create bank/ structure
mkdir -p "$WORKSPACE/bank/entities"

for f in world.md experience.md opinions.md; do
  target="$WORKSPACE/bank/$f"
  if [ ! -f "$target" ]; then
    touch "$target"
    echo "  created: bank/$f"
  else
    echo "  exists:  bank/$f (skipped)"
  fi
done

# 2. Copy GROWTH_LOG.md if missing
target="$WORKSPACE/GROWTH_LOG.md"
if [ ! -f "$target" ]; then
  cp "$TEMPLATES/GROWTH_LOG.md" "$target"
  echo "  created: GROWTH_LOG.md"
else
  echo "  exists:  GROWTH_LOG.md (skipped)"
fi

# 3. Offer to upgrade HEARTBEAT.md
target="$WORKSPACE/HEARTBEAT.md"
if [ ! -f "$target" ]; then
  cp "$TEMPLATES/HEARTBEAT.growth.md" "$target"
  echo "  created: HEARTBEAT.md (growth edition)"
elif grep -q "成長版" "$target" 2>/dev/null; then
  echo "  exists:  HEARTBEAT.md (growth edition already active, skipped)"
else
  echo ""
  echo "  HEARTBEAT.md exists but is not the growth edition."
  echo "  Growth template is at: $TEMPLATES/HEARTBEAT.growth.md"
  echo "  To upgrade: cp $TEMPLATES/HEARTBEAT.growth.md $target"
fi

echo ""
echo "✓ Growth system ready."
echo ""
echo "Next steps:"
echo "  1. Seed bank/world.md with basic facts (human's name, timezone, tools)"
echo "  2. Review HEARTBEAT.md — adjust weekly review timing if needed"
echo "  3. Start a session — the agent will pick up the growth protocol from AGENTS.md"
