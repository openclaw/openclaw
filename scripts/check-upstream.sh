#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_REF="${1:-origin/main}"
UPSTREAM_REF="${2:-upstream/main}"

git fetch origin --quiet --prune
git fetch upstream --quiet --prune

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
    echo "Unknown base ref: $BASE_REF" >&2
    exit 1
fi

if ! git rev-parse --verify "$UPSTREAM_REF" >/dev/null 2>&1; then
    echo "Unknown upstream ref: $UPSTREAM_REF" >&2
    exit 1
fi

if ! git merge-base "$BASE_REF" "$UPSTREAM_REF" >/dev/null 2>&1; then
    echo "NO_SHARED_HISTORY between $BASE_REF and $UPSTREAM_REF"
    echo "Run: bash scripts/bridge-upstream-history.sh"
    exit 2
fi

COUNTS=$(git rev-list --left-right --count "$BASE_REF...$UPSTREAM_REF")
FORK_ONLY=$(echo "$COUNTS" | awk '{print $1}')
UPSTREAM_ONLY=$(echo "$COUNTS" | awk '{print $2}')

if [ "$UPSTREAM_ONLY" = "0" ]; then
    echo "UP_TO_DATE (no upstream commits pending)"
    echo "Fork-only commits ahead of upstream: $FORK_ONLY"
    exit 0
fi

echo "BEHIND by $UPSTREAM_ONLY commits"
echo "Fork-only commits ahead of upstream: $FORK_ONLY"
echo
echo "Newest upstream commits not in $BASE_REF:"
git log "$BASE_REF..$UPSTREAM_REF" --oneline --no-merges | head -20

# Show files changed for quick relevance scan
echo
echo "Top changed paths in pending upstream range:"
git diff --name-only "$BASE_REF..$UPSTREAM_REF" | head -20
