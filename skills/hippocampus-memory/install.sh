#!/bin/bash
# Hippocampus Skill Installer
# Sets up memory directories, index.json, and cron jobs
#
# Usage: ./install.sh [--with-cron] [--with-agent]
#
# Options:
#   --with-cron   Set up cron jobs for decay and encoding
#   --with-agent  Configure hippocampus background agent (requires manual config merge)

set -e

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WITH_CRON=false
WITH_AGENT=false

for arg in "$@"; do
    case $arg in
        --with-cron) WITH_CRON=true ;;
        --with-agent) WITH_AGENT=true ;;
    esac
done

echo "🧠 Hippocampus Skill Installer"
echo "=============================="
echo ""
echo "Workspace: $WORKSPACE"
echo "Skill dir: $SKILL_DIR"
echo ""

# 1. Create memory directories
echo "📁 Creating memory directories..."
mkdir -p "$WORKSPACE/memory/user"
mkdir -p "$WORKSPACE/memory/self"
mkdir -p "$WORKSPACE/memory/relationship"
mkdir -p "$WORKSPACE/memory/world"
echo "   ✅ Created memory/user/, memory/self/, memory/relationship/, memory/world/"

# 2. Initialize index.json if not exists
if [ ! -f "$WORKSPACE/memory/index.json" ]; then
    echo "📄 Initializing index.json..."
    cat > "$WORKSPACE/memory/index.json" << 'EOF'
{
  "version": 1,
  "lastUpdated": null,
  "lastProcessedMessageId": null,
  "decayLastRun": null,
  "memories": []
}
EOF
    echo "   ✅ Created memory/index.json"
else
    echo "   ⏭️  memory/index.json already exists"
fi

# 3. Make scripts executable
echo "🔧 Making scripts executable..."
chmod +x "$SKILL_DIR/scripts/"*.sh
echo "   ✅ All scripts are executable"

# 4. Set up cron jobs (optional)
if [ "$WITH_CRON" = true ]; then
    echo ""
    echo "⏰ Cron job setup..."
    echo ""
    echo "Add these cron jobs via 'openclaw cron add' or manually:"
    echo ""
    echo "# Daily decay at 3 AM"
    echo "openclaw cron add --name hippocampus-decay \\"
    echo "  --cron '0 3 * * *' \\"
    echo "  --session main \\"
    echo "  --system-event '🧠 Run decay: WORKSPACE=$WORKSPACE $SKILL_DIR/scripts/decay.sh'"
    echo ""
    echo "# Encoding every 3 hours (adjust as needed)"
    echo "openclaw cron add --name hippocampus-encoding \\"
    echo "  --cron '0 9,12,15,18,21 * * *' \\"
    echo "  --session isolated \\"
    echo "  --agent-turn 'Process signals and encode memories...'"
    echo ""
fi

# 5. Agent config (optional)
if [ "$WITH_AGENT" = true ]; then
    echo ""
    echo "🤖 Agent configuration..."
    echo ""
    echo "Add this to your openclaw.json agents.list:"
    echo ""
    cat << EOF
{
  "id": "hippocampus",
  "workspace": "$WORKSPACE",
  "agentDir": "$SKILL_DIR/agentdir",
  "model": "anthropic/claude-sonnet-4-20250514",
  "subagents": {
    "allowAgents": ["main"]
  }
}
EOF
    echo ""
    echo "And add 'hippocampus' to main agent's subagents.allowAgents"
    echo ""
fi

# 6. Add extraPaths for HIPPOCAMPUS_CORE.md
echo ""
echo "📚 OpenClaw config recommendation:"
echo ""
echo "Add to memorySearch.extraPaths in openclaw.json:"
echo '  "extraPaths": ["HIPPOCAMPUS_CORE.md"]'
echo ""

# 7. Generate initial HIPPOCAMPUS_CORE.md
echo "🔄 Generating HIPPOCAMPUS_CORE.md..."
WORKSPACE="$WORKSPACE" "$SKILL_DIR/scripts/sync-core.sh" 2>/dev/null || echo "   (no memories yet)"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Add memory/index.json to .gitignore (contains personal data)"
echo "  2. Run: $SKILL_DIR/scripts/load-core.sh  # Test core loading"
echo "  3. Start capturing memories!"
echo ""
echo "See SKILL.md for usage instructions."
