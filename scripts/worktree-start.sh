#!/usr/bin/env bash
# Create an isolated worktree for a task.
# Usage: scripts/worktree-start.sh <task-slug>
#
# Creates ../openclaw-worktrees/<task-slug> with a new branch
# based on origin/main, and prints the worktree path.

set -euo pipefail

SLUG="${1:?Usage: worktree-start.sh <task-slug>}"
ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORKTREE_BASE="$(dirname "$ROOT_DIR")/openclaw-worktrees"
WORKTREE_PATH="$WORKTREE_BASE/$SLUG"
BRANCH_NAME="feat/$SLUG"

if [[ -d "$WORKTREE_PATH" ]]; then
  echo "Worktree already exists: $WORKTREE_PATH" >&2
  exit 1
fi

mkdir -p "$WORKTREE_BASE"

cd "$ROOT_DIR"

# Ensure origin/main is up to date
git fetch origin --quiet 2>/dev/null || true

# Create branch from origin/main
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
  echo "Branch '$BRANCH_NAME' already exists, using it" >&2
else
  git branch "$BRANCH_NAME" origin/main 2>/dev/null || git branch "$BRANCH_NAME" HEAD
fi

# Create worktree
git worktree add "$WORKTREE_PATH" "$BRANCH_NAME" 2>/dev/null

echo "$WORKTREE_PATH"
