#!/bin/bash
# rebase-patches.sh - Rebase local patches onto new OpenClaw release
#
# Usage: ./rebase-patches.sh <upstream-branch-or-tag>
# Example: ./rebase-patches.sh origin/main
#          ./rebase-patches.sh v2.4.0

set -e

UPSTREAM="${1:-origin/main}"
PATCH_BRANCH="patches/local-fixes"

# Save current position
echo "🔖 Saving current position..."
git branch -D "${PATCH_BRANCH}" 2>/dev/null || true

# Create patch branch at upstream
echo "📍 Creating patch branch at ${UPSTREAM}..."
git checkout -b "${PATCH_BRANCH}" "${UPSTREAM}"

# Cherry-pick the local fixes
# These commits are our patches:
# - ea6df49df: Discord EventQueue timeout fix
# - 5ffd36cb9: Anthropic rate limit config

echo "🔨 Applying Discord EventQueue timeout fix..."
git cherry-pick ea6df49df --no-commit || {
    echo "❌ Conflict in Discord timeout patch. Fix manually, then:"
    echo "   git add . && git cherry-pick --continue"
    exit 1
}

echo "🔨 Applying Anthropic rate limit config..."
git cherry-pick 5ffd36cb9 --no-commit || {
    echo "❌ Conflict in Anthropic rate limit patch. Fix manually, then:"
    echo "   git add . && git cherry-pick --continue"
    exit 1
}

# Amend the commit to mark it as our patch set
git commit -m "patch: local fixes for Discord timeout + Anthropic rate limits

Applied on top of: ${UPSTREAM}

Patches:
- Discord EventQueue timeout: 30s → 5min
- Auth profile rateLimit schema: rpm/tpm/rph

Rebased from commits:
- ea6df49df
- 5ffd36cb9"

echo ""
echo "✅ Patches rebased onto ${UPSTREAM}"
echo ""
echo "You are now on branch: ${PATCH_BRANCH}"
echo ""
echo "Next steps:"
echo "  1. Test: openclaw build && openclaw restart"
echo "  2. Switch your local work branch:"
echo "     git checkout -B <your-branch> ${PATCH_BRANCH}"
echo ""
