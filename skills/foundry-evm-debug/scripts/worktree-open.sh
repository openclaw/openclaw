#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <repo-url-or-path> <ref> [name]" >&2
  exit 64
fi

repo="$1"
ref="$2"
name="${3:-$ref}"

cache_root="${OPENCLAW_FOUNDRY_CACHE_ROOT:-$HOME/.openclaw/workspace-evm/git-cache}"
worktree_root="${OPENCLAW_FOUNDRY_WORKTREE_ROOT:-$HOME/.openclaw/workspace-evm/worktrees}"

mkdir -p "$cache_root" "$worktree_root"

sanitize() {
  printf '%s' "$1" | sed -E 's#^[./]+##; s#://#-#g; s#[:/@]#-#g; s#[^A-Za-z0-9._-]#-#g; s#-+#-#g; s#\.git$##'
}

repo_slug="$(sanitize "$repo")"
name_slug="$(sanitize "$name")"
if [[ -z "$repo_slug" || -z "$name_slug" ]]; then
  echo "repo or name sanitized to empty string" >&2
  exit 64
fi

cache_repo="${cache_root}/${repo_slug}.git"
target_dir="${worktree_root}/${repo_slug}/${name_slug}"

if [[ ! -d "$cache_repo" ]]; then
  git clone --mirror -- "$repo" "$cache_repo" >&2
else
  git --git-dir "$cache_repo" remote update --prune >&2
fi

mkdir -p "$(dirname "$target_dir")"

if [[ -e "$target_dir" ]]; then
  if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
    echo "stale directory at $target_dir, removing..." >&2
    rm -rf "$target_dir"
  else
    echo "worktree already exists: $target_dir" >&2
    printf '%s\n' "$target_dir"
    exit 0
  fi
fi

git --git-dir "$cache_repo" worktree add -- "$target_dir" "$ref" >&2

if [[ -f "$target_dir/.gitmodules" ]]; then
  git -C "$target_dir" submodule update --init --recursive >&2
fi

printf '%s\n' "$target_dir"
