#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[error] Not inside a git repo: $REPO_ROOT" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[error] Working tree is dirty. Commit or stash first." >&2
  git status --short
  exit 1
fi

if ! git show-ref --verify --quiet refs/heads/main; then
  echo "[error] Local branch 'main' not found." >&2
  exit 1
fi

if ! git show-ref --verify --quiet refs/heads/custom; then
  echo "[error] Local branch 'custom' not found." >&2
  exit 1
fi

echo "[1/5] Fetching upstream refs..."
git fetch origin --prune --tags

echo "[2/5] Syncing local main to origin/main..."
git checkout main
if ! git show-ref --verify --quiet refs/remotes/origin/main; then
  echo "[error] origin/main not found. Check remote refspec/remote config." >&2
  exit 1
fi
git reset --hard origin/main

echo "[3/5] Merging main into custom..."
git checkout custom
set +e
git merge --no-edit main
merge_rc=$?
set -e
if [[ $merge_rc -ne 0 ]]; then
  echo "[warn] Merge conflict detected. Resolve conflicts, then run:"
  echo "       git add -A && git commit"
  exit $merge_rc
fi

echo "[4/5] Post-merge summary:"
git --no-pager log --oneline --max-count=5

echo "[5/5] Done."
echo "Tip: run scripts/local/smoke-clarityos.sh for quick validation."
