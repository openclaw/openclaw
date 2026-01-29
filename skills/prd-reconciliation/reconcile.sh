#!/bin/bash
# PRD Reconciliation Helper
# Usage: ./reconcile.sh /path/to/project

PROJECT_DIR="${1:-.}"
PRD_FILE=""

# Find PRD (prefer versioned PRDs like PRD-v2.md)
for pattern in "PRD-v*.md" "PRD-*.md" "PRD.md" "prd-v*.md" "prd-*.md" "prd.md"; do
    found=$(find "$PROJECT_DIR" -maxdepth 2 -name "$pattern" 2>/dev/null | head -1)
    if [ -n "$found" ]; then
        PRD_FILE="$found"
        break
    fi
done

if [ -z "$PRD_FILE" ]; then
    echo "❌ No PRD found in $PROJECT_DIR"
    exit 1
fi

echo "📄 PRD: $PRD_FILE"
echo ""

# Extract status markers
echo "## Current Status Markers in PRD"
grep -n "Status.*Complete\|Status.*Planned\|Status.*Progress" "$PRD_FILE" | head -20
echo ""

# Code metrics
echo "## Code Metrics"
echo ""

# Find source files
SRC_FILES=$(find "$PROJECT_DIR" -type f \( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" \) \
    ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/.next/*" 2>/dev/null)

if [ -n "$SRC_FILES" ]; then
    echo "### File Count & Lines"
    echo "$SRC_FILES" | xargs wc -l 2>/dev/null | tail -5
    echo ""
    
    echo "### Function Count (approx)"
    echo "$SRC_FILES" | xargs grep -c "function\|=>" 2>/dev/null | grep -v ":0$" | sort -t: -k2 -nr | head -10
    echo ""
fi

# Check for common features
echo "## Feature Detection"
echo ""

features=("terminal" "agent" "browser" "git" "search" "settings" "theme")
for feature in "${features[@]}"; do
    count=$(echo "$SRC_FILES" | xargs grep -il "$feature" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$count" -gt 0 ]; then
        echo "✅ $feature: found in $count file(s)"
    else
        echo "❌ $feature: not found"
    fi
done

echo ""
echo "## Reconciliation Needed?"
echo "Compare the status markers above with the code metrics."
echo "If PRD says 'Planned' but code shows implementation, update the PRD."
