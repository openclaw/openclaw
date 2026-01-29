#!/bin/bash
# Analyze a feature request and recommend extension approach
# Usage: ./analyze-feature.sh "feature description"

FEATURE="$1"

if [[ -z "$FEATURE" ]]; then
    echo "Usage: ./analyze-feature.sh \"feature description\""
    exit 1
fi

echo "🔍 Feature Analysis"
echo "==================="
echo "Feature: $FEATURE"
echo ""

# Keywords analysis
echo "📊 Keyword Analysis"
echo "───────────────────"

# Skill indicators
if echo "$FEATURE" | grep -qiE "teach|learn|how to|guide|instruct|document|workflow"; then
    echo "  📚 SKILL indicators found:"
    echo "$FEATURE" | grep -oiE "teach|learn|how to|guide|instruct|document|workflow" | sort -u | sed 's/^/    - /'
    SKILL_SCORE=3
else
    SKILL_SCORE=0
fi

# Hook indicators
if echo "$FEATURE" | grep -qiE "when|event|trigger|before|after|on start|on new|inject|intercept"; then
    echo "  🪝 HOOK indicators found:"
    echo "$FEATURE" | grep -oiE "when|event|trigger|before|after|on start|on new|inject|intercept" | sort -u | sed 's/^/    - /'
    HOOK_SCORE=3
else
    HOOK_SCORE=0
fi

# Plugin indicators
if echo "$FEATURE" | grep -qiE "tool|command|cli|api|rpc|background|service|channel"; then
    echo "  🔌 PLUGIN indicators found:"
    echo "$FEATURE" | grep -oiE "tool|command|cli|api|rpc|background|service|channel" | sort -u | sed 's/^/    - /'
    PLUGIN_SCORE=3
else
    PLUGIN_SCORE=0
fi

# Cron indicators
if echo "$FEATURE" | grep -qiE "schedule|every|daily|hourly|weekly|at [0-9]|remind|timer"; then
    echo "  ⏰ CRON indicators found:"
    echo "$FEATURE" | grep -oiE "schedule|every|daily|hourly|weekly|at [0-9]|remind|timer" | sort -u | sed 's/^/    - /'
    CRON_SCORE=3
else
    CRON_SCORE=0
fi

# Node indicators
if echo "$FEATURE" | grep -qiE "camera|screen|device|phone|mac|ios|android|location|notify"; then
    echo "  📡 NODE indicators found:"
    echo "$FEATURE" | grep -oiE "camera|screen|device|phone|mac|ios|android|location|notify" | sort -u | sed 's/^/    - /'
    NODE_SCORE=3
else
    NODE_SCORE=0
fi

echo ""
echo "🎯 Recommendation"
echo "─────────────────"

# Find highest score
max_score=0
recommendation=""

if [[ $SKILL_SCORE -gt $max_score ]]; then
    max_score=$SKILL_SCORE
    recommendation="SKILL"
fi
if [[ $HOOK_SCORE -gt $max_score ]]; then
    max_score=$HOOK_SCORE
    recommendation="HOOK"
fi
if [[ $PLUGIN_SCORE -gt $max_score ]]; then
    max_score=$PLUGIN_SCORE
    recommendation="PLUGIN"
fi
if [[ $CRON_SCORE -gt $max_score ]]; then
    max_score=$CRON_SCORE
    recommendation="CRON"
fi
if [[ $NODE_SCORE -gt $max_score ]]; then
    max_score=$NODE_SCORE
    recommendation="NODE"
fi

if [[ -z "$recommendation" ]]; then
    echo "  ❓ Unclear - manual analysis needed"
    echo ""
    echo "  Consider:"
    echo "    - If it teaches the agent → SKILL"
    echo "    - If it reacts to events → HOOK"
    echo "    - If it adds capabilities → PLUGIN"
    echo "    - If it's scheduled → CRON/HEARTBEAT"
    echo "    - If it uses devices → NODE"
else
    echo "  Primary: $recommendation"
    
    case $recommendation in
        SKILL)
            echo ""
            echo "  Create: skills/<name>/SKILL.md"
            echo "  Template: skills/clawdbot-architect/templates/skill-template.md"
            ;;
        HOOK)
            echo ""
            echo "  Create: hooks/<name>/HOOK.md + handler.ts"
            echo "  Template: skills/clawdbot-architect/templates/hook-template/"
            ;;
        PLUGIN)
            echo ""
            echo "  Create: Plugin with clawdbot.plugin.json"
            echo "  Consider bundling skill for usage guidance"
            ;;
        CRON)
            echo ""
            echo "  Command: clawdbot cron add \"<text>\" --schedule \"<cron>\""
            echo "  Or: Use heartbeat for batched checks"
            ;;
        NODE)
            echo ""
            echo "  Use: nodes tool with existing capabilities"
            echo "  Or: Add new node command if needed"
            ;;
    esac
fi

echo ""
echo "Done."
