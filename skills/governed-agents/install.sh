#!/usr/bin/env bash
# Governed Agents — Installer for OpenClaw
# Copies the governed_agents Python package into your workspace.
# No pip required — pure Python stdlib only.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
TARGET="$WORKSPACE/governed_agents"

echo "🛡️  Installing governed-agents..."

if [ -d "$TARGET" ]; then
    echo "  Updating existing installation at $TARGET..."
    cp -r "$SKILL_DIR/governed_agents/." "$TARGET/"
else
    echo "  Installing to $TARGET..."
    cp -r "$SKILL_DIR/governed_agents" "$TARGET"
fi

echo ""
echo "  Running verification suite..."
python3 "$TARGET/tests/test_verification.py"
echo ""
echo "✅ governed-agents installed at $TARGET"
echo "   Usage: from governed_agents.orchestrator import GovernedOrchestrator"
