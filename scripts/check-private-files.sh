#!/bin/bash
# Check for private files before creating PR
# Usage: ./scripts/check-private-files.sh

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'

echo "🔍 Checking for private files in current branch..."

PRIVATE_PATTERNS=(
    "memory/.*\.md"
    "CODE_OF_CONDUCT\.md"
    "WORKFLOW\.md"
    "BUGFIX_WORKFLOW\.md"
    "2026-.*\.md"
    "HEARTBEAT\.md"
    "SOUL\.md"
    "TOOLS\.md"
    "IDENTITY\.md"
    "USER\.md"
)

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BASE_BRANCH="upstream/main"

echo "Branch: $CURRENT_BRANCH"
echo "Base: $BASE_BRANCH"
echo ""

# Get files changed in current branch
CHANGED_FILES=$(git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null || echo "")

if [ -z "$CHANGED_FILES" ]; then
    echo -e "${YELLOW}⚠️  No changes found relative to $BASE_BRANCH${NC}"
    echo "Make sure your branch is based on upstream/main"
    exit 0
fi

FOUND_PRIVATE=false

for pattern in "${PRIVATE_PATTERNS[@]}"; do
    MATCHED=$(echo "$CHANGED_FILES" | grep -E "$pattern" || true)
    if [ -n "$MATCHED" ]; then
        if [ "$FOUND_PRIVATE" = false ]; then
            echo -e "${RED}🚨 Found private files in branch:${NC}"
            FOUND_PRIVATE=true
        fi
        echo "  ❌ $MATCHED"
    fi
done

if [ "$FOUND_PRIVATE" = true ]; then
    echo ""
    echo -e "${RED}❌ Cannot create PR with private files!${NC}"
    echo ""
    echo "Options:"
    echo "  1. Remove private files from this branch"
    echo "  2. Move private files to memory-private repository"
    echo "  3. Create a new branch from upstream/main"
    echo ""
    echo "To remove from branch:"
    echo "  git reset HEAD <file>"
    echo "  git checkout -- <file>"
    echo ""
    exit 1
fi

echo -e "${GREEN}✅ No private files detected${NC}"
echo ""
echo "Safe to create PR!"
exit 0
