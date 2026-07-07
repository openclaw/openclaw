#!/bin/bash
# Script to patch dreaming journal files for i18n support
# This script modifies the compiled JavaScript files to use Chinese translations
# 
# Usage: ./scripts/patch-dreaming-i18n.sh [language]
# Default language: zh-CN (Chinese Simplified)
#
# Note: This script will be overwritten on openclaw updates.
# For permanent i18n support, the changes should be made to the source TypeScript files.

set -e

LANGUAGE="${1:-zh-CN}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.npm-global/lib/node_modules/openclaw}"

echo "Patching dreaming journal for language: $LANGUAGE"
echo "OpenClaw directory: $OPENCLAW_DIR"

# Check if openclaw directory exists
if [ ! -d "$OPENCLAW_DIR" ]; then
    echo "Error: OpenClaw directory not found at $OPENCLAW_DIR"
    exit 1
fi

# Function to patch a file
patch_file() {
    local file="$1"
    local old_text="$2"
    local new_text="$3"
    
    if [ ! -f "$file" ]; then
        echo "Warning: File not found: $file"
        return 1
    fi
    
    if grep -q "$old_text" "$file"; then
        sed -i "s|$old_text|$new_text|g" "$file"
        echo "Patched: $file"
    else
        echo "Pattern not found in $file: $old_text"
    fi
}

# Patch dreaming-narrative files
for file in "$OPENCLAW_DIR"/dist/dreaming-narrative-*.js; do
    if [ -f "$file" ]; then
        patch_file "$file" "# Dream Diary" "# 梦境日记"
    fi
done

# Patch dreaming-dreams-file files
for file in "$OPENCLAW_DIR"/dist/dreaming-dreams-file-*.js; do
    if [ -f "$file" ]; then
        patch_file "$file" "## Deep Sleep" "## 深度睡眠"
    fi
done

# Patch dreaming-markdown files
for file in "$OPENCLAW_DIR"/dist/dreaming-markdown-*.js; do
    if [ -f "$file" ]; then
        patch_file "$file" "## Light Sleep" "## 浅度睡眠"
        patch_file "$file" "## REM Sleep" "## REM 睡眠"
        patch_file "$file" "# Deep Sleep" "# 深度睡眠"
        patch_file "$file" "No notable updates" "无显著更新"
    fi
done

# Patch dreaming-phases files
for file in "$OPENCLAW_DIR"/dist/dreaming-phases-*.js; do
    if [ -f "$file" ]; then
        patch_file "$file" "## Light Sleep" "## 浅度睡眠"
        patch_file "$file" "## REM Sleep" "## REM 睡眠"
        patch_file "$file" "\"### Reflections\"" "\"### 反思\""
        patch_file "$file" "\"### Possible Lasting Truths\"" "\"### 可能的持久真理\""
        patch_file "$file" "\"- No notable updates.\"" "\"- 无显著更新。\""
        patch_file "$file" "\"- No strong patterns surfaced.\"" "\"- 无显著模式浮现。\""
        patch_file "$file" "\"- No strong candidate truths surfaced.\"" "\"- 无强有力的候选真理浮现。\""
        patch_file "$file" "\"- Candidate:" "\"- 候选:"
        patch_file "$file" "\"  - confidence:" "\"  - 置信度:"
        patch_file "$file" "\"  - evidence:" "\"  - 证据:"
        patch_file "$file" "\"  - recalls:" "\"  - 回顾次数:"
        patch_file "$file" "\"  - status: staged\"" "\"  - 状态: 暂存\""
    fi
done

# Patch dreaming files
for file in "$OPENCLAW_DIR"/dist/dreaming-*.js; do
    if [ -f "$file" ]; then
        patch_file "$file" "Ranked.*candidate(s) for durable promotion" "评估了 \${candidates.length} 个候选条目用于持久化提升"
        patch_file "$file" "Promoted.*candidate(s) into MEMORY.md" "提升了 \${applied.applied} 个候选条目到 MEMORY.md"
    fi
done

echo "Patching complete!"
echo "Please restart OpenClaw to apply changes."
