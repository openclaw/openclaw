#!/bin/bash
# Audit Clawdbot Extension Systems
# Usage: ./audit-extensions.sh [workspace]

WORKSPACE="${1:-$(pwd)}"
CLAWDBOT_DIR="${HOME}/.clawdbot"
CLAWDBOT_PKG="/usr/local/lib/node_modules/clawdbot"

echo "🏗️ Clawdbot Extension Audit"
echo "==========================="
echo "Workspace: $WORKSPACE"
echo "Date: $(date)"
echo ""

# ═══════════════════════════════════════════════════════════
# SKILLS AUDIT
# ═══════════════════════════════════════════════════════════
echo "📚 SKILLS"
echo "─────────"

SKILL_DIRS=("$WORKSPACE/skills" "$CLAWDBOT_DIR/skills" "$CLAWDBOT_PKG/skills")

total_skills=0
for dir in "${SKILL_DIRS[@]}"; do
    if [[ -d "$dir" ]]; then
        count=$(find "$dir" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
        echo "  $(basename $(dirname $dir))/skills: $count skills"
        total_skills=$((total_skills + count))
    fi
done
echo "  Total: $total_skills skills"
echo ""

# Check for large skills (context bloat)
echo "  ⚠️  Large skills (>5KB):"
for dir in "${SKILL_DIRS[@]}"; do
    if [[ -d "$dir" ]]; then
        find "$dir" -name "SKILL.md" -size +5k 2>/dev/null | while read f; do
            size=$(wc -c < "$f" | tr -d ' ')
            echo "    - $(dirname $f | xargs basename): ${size} bytes"
        done
    fi
done
echo ""

# ═══════════════════════════════════════════════════════════
# HOOKS AUDIT
# ═══════════════════════════════════════════════════════════
echo "🪝 HOOKS"
echo "────────"

HOOK_DIRS=("$WORKSPACE/hooks" "$CLAWDBOT_DIR/hooks" "$CLAWDBOT_PKG/dist/hooks/bundled")

for dir in "${HOOK_DIRS[@]}"; do
    if [[ -d "$dir" ]]; then
        echo "  $(echo $dir | sed "s|$HOME|~|"):"
        for hook in "$dir"/*/; do
            if [[ -f "$hook/HOOK.md" ]]; then
                name=$(basename "$hook")
                events=$(grep -o 'events.*\[.*\]' "$hook/HOOK.md" 2>/dev/null | head -1)
                echo "    - $name ${events:-[no events]}"
            fi
        done
    fi
done
echo ""

# Check enabled hooks
echo "  ✓ Enabled hooks:"
clawdbot hooks list 2>/dev/null | grep "✓ ready" | awk '{print "    - "$3}'
echo ""

# ═══════════════════════════════════════════════════════════
# PLUGINS AUDIT
# ═══════════════════════════════════════════════════════════
echo "🔌 PLUGINS"
echo "──────────"

clawdbot plugins list 2>/dev/null | head -20
echo ""

# ═══════════════════════════════════════════════════════════
# CHANNELS AUDIT
# ═══════════════════════════════════════════════════════════
echo "📱 CHANNELS"
echo "───────────"

CONFIG_FILE="$CLAWDBOT_DIR/clawdbot.json"
if [[ -f "$CONFIG_FILE" ]]; then
    for channel in whatsapp telegram discord slack signal imessage googlechat; do
        enabled=$(grep -A5 "\"$channel\"" "$CONFIG_FILE" 2>/dev/null | grep -o '"enabled":\s*true' | head -1)
        if [[ -n "$enabled" ]]; then
            echo "  ✓ $channel: enabled"
        fi
    done
fi
echo ""

# ═══════════════════════════════════════════════════════════
# CRON JOBS AUDIT
# ═══════════════════════════════════════════════════════════
echo "⏰ CRON JOBS"
echo "────────────"

clawdbot cron list 2>/dev/null | head -15
echo ""

# ═══════════════════════════════════════════════════════════
# NODES AUDIT
# ═══════════════════════════════════════════════════════════
echo "📡 NODES"
echo "────────"

clawdbot nodes status 2>/dev/null | head -10
echo ""

# ═══════════════════════════════════════════════════════════
# RECOMMENDATIONS
# ═══════════════════════════════════════════════════════════
echo "💡 RECOMMENDATIONS"
echo "──────────────────"

# Check for potential issues
issues=0

# Skills without descriptions
for dir in "${SKILL_DIRS[@]}"; do
    if [[ -d "$dir" ]]; then
        find "$dir" -name "SKILL.md" 2>/dev/null | while read f; do
            if ! grep -q "^description:" "$f" 2>/dev/null; then
                echo "  ⚠️  Missing description: $(dirname $f | xargs basename)"
                issues=$((issues + 1))
            fi
        done
    fi
done

# Hooks on agent:bootstrap (performance concern)
bootstrap_hooks=$(grep -r "agent:bootstrap" "$WORKSPACE/hooks" "$CLAWDBOT_DIR/hooks" 2>/dev/null | wc -l | tr -d ' ')
if [[ $bootstrap_hooks -gt 2 ]]; then
    echo "  ⚠️  $bootstrap_hooks hooks on agent:bootstrap - may impact response time"
fi

# Large workspace
workspace_size=$(du -sh "$WORKSPACE" 2>/dev/null | awk '{print $1}')
echo "  ℹ️  Workspace size: $workspace_size"

echo ""
echo "Audit complete."
