#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BASE_REF="${BASE_REF:-origin/main}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
BRANCH="${1:-sync/bridge-upstream-$(date +%Y%m%d)}"
BRIDGE_STRATEGY="${BRIDGE_STRATEGY:-ours}"

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

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "Local branch already exists: $BRANCH" >&2
    exit 1
fi

if git merge-base "$BASE_REF" "$UPSTREAM_REF" >/dev/null 2>&1; then
    echo "Shared history already exists between $BASE_REF and $UPSTREAM_REF."
    echo "No bridge commit needed."
    exit 0
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bridge-XXXXXX")"
echo "Using temporary worktree: $TMP_DIR"

git worktree add -b "$BRANCH" "$TMP_DIR" "$BASE_REF" >/dev/null

set +e
(
    cd "$TMP_DIR"
    if [ "$BRIDGE_STRATEGY" = "ours" ]; then
        git merge --no-ff --allow-unrelated-histories -s ours "$UPSTREAM_REF" \
            -m "chore(sync): bridge upstream history into fork main (strategy=ours)"
    elif [ "$BRIDGE_STRATEGY" = "recursive" ]; then
        git merge --no-ff --allow-unrelated-histories "$UPSTREAM_REF" \
            -m "chore(sync): bridge upstream history into fork main (strategy=recursive)"
    else
        echo "Unknown BRIDGE_STRATEGY: $BRIDGE_STRATEGY (expected 'ours' or 'recursive')" >&2
        exit 1
    fi
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
echo "Bridge branch created successfully: $BRANCH"
if [ "$BRIDGE_STRATEGY" = "ours" ]; then
    echo "Bridge strategy: ours (fork content preserved exactly)"
fi
echo "Next steps:"
echo "  git push -u origin $BRANCH"
echo "  Open PR: $BRANCH -> main"
echo "After this PR is merged, daily upstream merges can run normally."
