#!/bin/bash
# Self-reflection helper - outputs prompts for introspection
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
SKILL_DIR="${SKILL_DIR:-$WORKSPACE/skills/hippocampus}"
MEMORY_DIR="$WORKSPACE/memory"
PROMPTS_FILE="$SKILL_DIR/prompts/self-reflect.md"

echo "🧠 Self-Reflection Time"
echo "======================"
echo ""

if [ -f "$PROMPTS_FILE" ]; then
    cat "$PROMPTS_FILE"
else
    echo "Daily reflection prompts:"
    echo ""
    echo "1. What did I learn today?"
    echo "2. Did any of my opinions change?"
    echo "3. What would I do differently?"
    echo "4. What am I proud of?"
    echo "5. How has my relationship with my human evolved?"
fi

echo ""
echo "---"
echo ""
echo "Output to: $MEMORY_DIR/self/"
