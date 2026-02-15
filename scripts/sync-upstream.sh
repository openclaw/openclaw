#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_REF="${BASE_REF:-origin/main}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
BRANCH="${1:-sync/upstream-$(date +%Y%m%d)}"

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
    echo "No shared history between $BASE_REF and $UPSTREAM_REF." >&2
    echo "Run once first: bash scripts/bridge-upstream-history.sh" >&2
    exit 2
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "Local branch already exists: $BRANCH" >&2
    exit 1
fi

COUNTS=$(git rev-list --left-right --count "$BASE_REF...$UPSTREAM_REF")
FORK_ONLY=$(echo "$COUNTS" | awk '{print $1}')
UPSTREAM_ONLY=$(echo "$COUNTS" | awk '{print $2}')

if [ "$UPSTREAM_ONLY" = "0" ]; then
    echo "No upstream commits pending. Nothing to sync."
    echo "Fork-only commits ahead of upstream: $FORK_ONLY"
    exit 0
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-sync-XXXXXX")"
echo "Using temporary worktree: $TMP_DIR"

git worktree add -b "$BRANCH" "$TMP_DIR" "$BASE_REF" >/dev/null

set +e
(
    cd "$TMP_DIR"
    git merge --no-ff "$UPSTREAM_REF" \
        -m "chore(sync): merge upstream/main into main ($(date -u +%Y-%m-%d))"
)
MERGE_RC=$?
set -e

if [ "$MERGE_RC" -ne 0 ]; then
    echo
    echo "Merge produced conflicts. Resolve them in: $TMP_DIR"
    echo "After resolving conflicts:"
    echo "  cd $TMP_DIR"
    echo "  git add -A && git commit"
    echo "  git push -u origin $BRANCH"
    echo "Then open a PR: $BRANCH -> main"
    exit "$MERGE_RC"
fi

git worktree remove "$TMP_DIR" --force >/dev/null

echo
echo "Sync branch created successfully: $BRANCH"
echo "Upstream commits merged: $UPSTREAM_ONLY"
echo "Next steps:"
echo "  git push -u origin $BRANCH"
echo "  Open PR: $BRANCH -> main"
