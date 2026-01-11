#!/usr/bin/env bash
# Sync upstream changes from clawdbot/clawdbot into dbhurley/clawd

set -e

echo "🔄 Syncing upstream changes from clawdbot/clawdbot..."

# Ensure we're on main branch
current_branch=$(git branch --show-current)
if [ "$current_branch" != "main" ]; then
    echo "⚠️  Not on main branch. Currently on: $current_branch"
    echo "Switch to main first: git switch main"
    exit 1
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "⚠️  You have uncommitted changes. Please commit or stash them first."
    git status --short
    exit 1
fi

# Fetch latest from upstream
echo "📥 Fetching from upstream..."
git fetch upstream

# Show what's new
echo ""
echo "📊 New commits from upstream:"
git log --oneline HEAD..upstream/main --max-count=10

commit_count=$(git rev-list --count HEAD..upstream/main)
if [ "$commit_count" -eq 0 ]; then
    echo "✅ Already up to date with upstream!"
    exit 0
fi

echo ""
echo "Found $commit_count new commits from upstream."
echo ""
read -p "Merge these changes? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Merge cancelled"
    exit 0
fi

# Merge upstream changes
echo "🔀 Merging upstream/main..."
git merge upstream/main -m "Merge upstream changes from clawdbot/clawdbot"

echo ""
echo "✅ Successfully merged $commit_count commits from upstream!"
echo ""
echo "Next steps:"
echo "  1. Review the changes: git log --oneline -10"
echo "  2. Run tests: pnpm test"
echo "  3. Push to your fork: git push personal main"