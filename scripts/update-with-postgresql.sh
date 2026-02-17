#!/bin/bash
# Update OpenClaw while preserving PostgreSQL support
# Run this script after pulling upstream OpenClaw updates

set -e

echo "🦞 OpenClaw PostgreSQL-Aware Update Script"
echo "==========================================="
echo ""

# Check if we're on the postgresql-support branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "postgresql-support" ]; then
    echo "⚠️  Warning: Not on postgresql-support branch (currently on: $CURRENT_BRANCH)"
    echo "   This script should be run from postgresql-support branch"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Stash any uncommitted changes
echo "📦 Stashing uncommitted changes..."
git stash push -m "Pre-update stash $(date +%Y%m%d-%H%M%S)"

# Fetch upstream changes
echo "📥 Fetching upstream OpenClaw changes..."
if ! git remote | grep -q upstream; then
    echo "   Adding upstream remote..."
    git remote add upstream https://github.com/anthropics/openclaw.git
fi
git fetch upstream

# Checkout and update main branch
echo "🔄 Updating main branch..."
git checkout main
git merge upstream/main --no-edit || {
    echo "❌ Merge conflict in main branch"
    echo "   Please resolve conflicts and run this script again"
    exit 1
}

# Rebase PostgreSQL changes
echo "🔀 Rebasing PostgreSQL support onto updated main..."
git checkout postgresql-support
git rebase main || {
    echo "❌ Rebase conflict detected"
    echo ""
    echo "   To resolve:"
    echo "   1. Fix conflicts in the files listed above"
    echo "   2. git add <resolved-files>"
    echo "   3. git rebase --continue"
    echo "   4. Run this script again"
    exit 1
}

# Reinstall dependencies
echo "📦 Reinstalling dependencies..."
pnpm install

# Rebuild
echo "🔨 Building OpenClaw with PostgreSQL support..."
npm run build || {
    echo "❌ Build failed"
    echo "   PostgreSQL changes may need updates for compatibility"
    echo "   Check POSTGRESQL.md for recent changes"
    exit 1
}

# Install globally
echo "🌐 Installing globally..."
npm install -g .

# Pop stashed changes
echo "📤 Restoring stashed changes..."
git stash pop || echo "   (No stashed changes to restore)"

echo ""
echo "✅ Update complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Test with: openclaw --version"
echo "   2. Verify PostgreSQL connection: openclaw --agent main"
echo "   3. Check schemas: psql -h host -U openclaw_router -d openclaw_router -c '\dn'"
echo "   4. Push updated branch: git push origin postgresql-support --force-with-lease"
echo ""
echo "📖 See POSTGRESQL.md for troubleshooting if issues occur"
