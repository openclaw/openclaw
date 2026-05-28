#!/usr/bin/env bash
# Check if the default checkout is clean and synchronized with origin/main.
# Exit codes:
#   0 = DEFAULT_OK (clean and synchronized)
#   1 = DEFAULT_BEHIND_DRY_RUN (clean but behind, report only)
#   2 = DEFAULT_BEHIND_SYNCED (clean and behind, needs sync)
#   3 = DEFAULT_DIRTY (uncommitted changes)
#   4 = DEFAULT_DIVERGED (ahead of origin/main — incident)
#   5 = DEFAULT_NOT_MAIN (not on main branch — incident)

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")"

if [[ "$BRANCH" != "main" ]]; then
  echo "DEFAULT_NOT_MAIN: on branch '$BRANCH', expected 'main'" >&2
  exit 5
fi

# Check for uncommitted changes (staged, unstaged, or untracked)
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  echo "DEFAULT_DIRTY: uncommitted changes detected" >&2
  git status --short >&2
  exit 3
fi

# Check for untracked files (excluding known safe patterns)
UNTRACKED=$(git ls-files --others --exclude-standard | grep -v -E '^(\.env\.local|node_modules/|dist/|\.next/|logs/|\.turbo/)' || true)
if [[ -n "$UNTRACKED" ]]; then
  echo "DEFAULT_DIRTY: untracked files detected:" >&2
  echo "$UNTRACKED" >&2
  exit 3
fi

# Fetch origin to check sync status
git fetch origin --quiet 2>/dev/null || true

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main 2>/dev/null || echo "")"

if [[ -z "$REMOTE_SHA" ]]; then
  echo "DEFAULT_OK: clean (no remote to compare)"
  exit 0
fi

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  echo "DEFAULT_OK: clean and synchronized with origin/main"
  exit 0
fi

MERGE_BASE="$(git merge-base HEAD origin/main 2>/dev/null || echo "")"

if [[ "$LOCAL_SHA" == "$MERGE_BASE" ]]; then
  BEHIND=$(git rev-list --count HEAD..origin/main)
  echo "DEFAULT_BEHIND_DRY_RUN: clean, behind origin/main by $BEHIND commit(s)"
  exit 1
fi

if [[ "$REMOTE_SHA" == "$MERGE_BASE" ]]; then
  AHEAD=$(git rev-list --count origin/main..HEAD)
  echo "DEFAULT_DIVERGED: ahead of origin/main by $AHEAD commit(s) — INCIDENT" >&2
  exit 4
fi

echo "DEFAULT_DIVERGED: diverged from origin/main — INCIDENT" >&2
exit 4
