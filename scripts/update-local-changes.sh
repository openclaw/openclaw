#!/bin/bash
# Update OpenClaw from GitHub while preserving local changes on local/custom-features branch
# Usage: ./scripts/update-local-changes.sh

set -e

MAIN_BRANCH="main"
LOCAL_BRANCH="local/custom-features"
REMOTE="origin"

echo "🔄 Starting OpenClaw update with local changes preservation..."
echo ""

# Check if local branch exists
if ! git show-ref --quiet refs/heads/$LOCAL_BRANCH; then
    echo "❌ Error: $LOCAL_BRANCH branch does not exist"
    echo "Create it first with: git checkout -b $LOCAL_BRANCH"
    exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Fetch latest from GitHub
echo "📥 Fetching latest from GitHub..."
git fetch $REMOTE

# Update main branch
echo "🔀 Updating $MAIN_BRANCH branch..."
git checkout $MAIN_BRANCH
git reset --hard $REMOTE/$MAIN_BRANCH

# Rebase local changes
echo "📝 Rebasing local changes onto latest $MAIN_BRANCH..."
git checkout $LOCAL_BRANCH

if git rebase $MAIN_BRANCH; then
    echo ""
    echo "✅ Success! Your local changes are now on top of the latest GitHub code"
    echo ""
    git log --oneline -5
else
    echo ""
    echo "⚠️  Rebase conflict detected"
    echo ""
    echo "To resolve:"
    echo "  1. Fix conflicts in your editor"
    echo "  2. git add ."
    echo "  3. git rebase --continue"
    echo ""
    echo "To abort and try again:"
    echo "  git rebase --abort"
    exit 1
fi
