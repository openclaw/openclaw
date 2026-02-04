#!/bin/bash
# Sync with upstream OpenClaw repository
# Run this script to pull latest updates from the original project

set -e

BRANCH="${1:-main}"
MODE="${2:-rebase}"  # rebase or merge

echo "🔄 Syncing with upstream OpenClaw..."

# Fetch latest from upstream
echo ""
echo "📥 Fetching from upstream..."
git fetch upstream

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    echo "⚠️  You have uncommitted changes. Commit or stash them first."
    git status --short
    exit 1
fi

# Get current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo ""
echo "🔀 Current branch: $CURRENT_BRANCH"

if [ "$MODE" = "merge" ]; then
    echo "🔀 Merging upstream/$BRANCH into $CURRENT_BRANCH..."
    git merge upstream/$BRANCH --no-edit
else
    echo "🔀 Rebasing $CURRENT_BRANCH onto upstream/$BRANCH..."
    git rebase upstream/$BRANCH
fi

echo ""
echo "✅ Sync complete!"

# Show what changed
echo ""
echo "📋 Recent upstream changes:"
git log --oneline -10 upstream/$BRANCH

echo ""
echo "💡 Tips:"
echo "   - Run 'pnpm install' if dependencies changed"
echo "   - Run 'pnpm build' to rebuild"
echo "   - Check CHANGELOG.md for breaking changes"
