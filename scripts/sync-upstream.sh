#!/bin/bash
set -euo pipefail

# Sync ClawMongo fork with upstream openclaw/openclaw.
# Usage: bash scripts/sync-upstream.sh [--merge]

echo "=== ClawMongo Upstream Sync ==="

# Ensure upstream remote exists
if ! git remote get-url upstream &>/dev/null; then
  echo "Adding upstream remote..."
  git remote add upstream https://github.com/openclaw/openclaw.git
fi

# Fetch upstream
echo "Fetching upstream..."
git fetch upstream main --quiet

# Show divergence
BEHIND=$(git rev-list --count HEAD..upstream/main)
AHEAD=$(git rev-list --count upstream/main..HEAD)
echo "Status: ${AHEAD} ahead, ${BEHIND} behind upstream/main"

if [ "$BEHIND" -eq 0 ]; then
  echo "Already up to date with upstream."
  exit 0
fi

echo ""
echo "--- Conflict hotspots (our modified files) ---"
HOTSPOTS=(
  "src/config/types.memory.ts"
  "src/memory/types.ts"
  "src/memory/backend-config.ts"
  "src/memory/search-manager.ts"
)
for file in "${HOTSPOTS[@]}"; do
  if git diff HEAD...upstream/main --name-only | grep -q "$file"; then
    echo "  CHANGED: $file"
  else
    echo "  OK:      $file"
  fi
done

echo ""
echo "All upstream changes:"
git diff --stat HEAD...upstream/main | tail -5

if [ "${1:-}" = "--merge" ]; then
  echo ""
  echo "Merging upstream/main..."
  git merge upstream/main --no-edit
  echo ""
  echo "Post-merge checklist:"
  echo "  1. pnpm install"
  echo "  2. npx tsc --noEmit"
  echo "  3. npx vitest run src/memory/ src/wizard/onboarding-memory.test.ts"
  echo "  4. git push"
else
  echo ""
  echo "To merge: bash scripts/sync-upstream.sh --merge"
  echo "Or manually: git merge upstream/main"
fi
