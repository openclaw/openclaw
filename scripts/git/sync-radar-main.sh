#!/usr/bin/env bash

set -euo pipefail

main_branch="main"
integration_branch="radar/main"
upstream_remote="upstream"
origin_remote="origin"

usage() {
  cat <<'EOF'
Usage: scripts/git/sync-radar-main.sh

Sync workflow:
  1. upstream/main -> origin/main
  2. origin/main -> radar/main

Requirements:
  - clean working tree
  - remotes "origin" and "upstream"
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not inside a git repository." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit, stash, or discard changes before syncing." >&2
  exit 1
fi

if ! git remote get-url "$origin_remote" >/dev/null 2>&1; then
  echo "Missing remote: $origin_remote" >&2
  exit 1
fi

if ! git remote get-url "$upstream_remote" >/dev/null 2>&1; then
  echo "Missing remote: $upstream_remote" >&2
  exit 1
fi

echo "==> Fetching remotes"
git fetch "$upstream_remote" "$main_branch"
git fetch "$origin_remote" "$main_branch" "$integration_branch" || true

echo "==> Updating $main_branch from $upstream_remote/$main_branch"
git checkout "$main_branch"
git merge --ff-only "$upstream_remote/$main_branch"
git push "$origin_remote" "$main_branch"

if git show-ref --verify --quiet "refs/heads/$integration_branch"; then
  echo "==> Switching to existing $integration_branch"
  git checkout "$integration_branch"
elif git show-ref --verify --quiet "refs/remotes/$origin_remote/$integration_branch"; then
  echo "==> Creating local $integration_branch from $origin_remote/$integration_branch"
  git checkout -b "$integration_branch" "$origin_remote/$integration_branch"
else
  echo "==> Creating $integration_branch from $main_branch"
  git checkout -b "$integration_branch" "$main_branch"
fi

echo "==> Merging $main_branch into $integration_branch"
git merge "$main_branch"
git push -u "$origin_remote" "$integration_branch"

echo "==> Sync complete"
echo "Next step: branch feature work from $integration_branch"
