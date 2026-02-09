#!/bin/bash
# Setup script for Cursor users
# Run this after: npx skills add austintgriffith/ethereum-wingman

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(pwd)"

# Check if we're in a project with the skill installed
if [ -f ".agents/skills/ethereum-wingman/AGENTS.md" ]; then
    AGENTS_FILE=".agents/skills/ethereum-wingman/AGENTS.md"
elif [ -f "$SKILL_DIR/AGENTS.md" ]; then
    AGENTS_FILE="$SKILL_DIR/AGENTS.md"
else
    echo "❌ Error: Could not find ethereum-wingman skill"
    echo "   Run: npx skills add austintgriffith/ethereum-wingman"
    exit 1
fi

# Create symlink to .cursorrules
if [ -f ".cursorrules" ]; then
    echo "⚠️  .cursorrules already exists"
    read -p "   Overwrite? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "   Skipped."
        exit 0
    fi
    rm .cursorrules
fi

# Create symlink (so it auto-updates with skill)
ln -sf "$AGENTS_FILE" .cursorrules

echo "✅ Created .cursorrules -> $AGENTS_FILE"
echo ""
echo "🚀 Cursor is now configured with ethereum-wingman!"
echo "   Restart Cursor or reload the window to apply."
