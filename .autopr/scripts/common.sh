#!/usr/bin/env bash
set -euo pipefail

readonly AUTOPR_BRANCH_REGEX='^codex/[a-z0-9._-]+/[a-z0-9._-]+$'

repo_root() {
  git rev-parse --show-toplevel
}

is_autopr_branch() {
  local branch="$1"
  [[ "$branch" =~ $AUTOPR_BRANCH_REGEX ]]
}

is_linked_worktree() {
  local git_dir
  git_dir="$(git rev-parse --absolute-git-dir)"
  [[ "$git_dir" == *"/.git/worktrees/"* ]]
}

resolve_base_ref() {
  local input_ref="${1:-upstream/main}"
  if git show-ref --verify --quiet "refs/remotes/${input_ref#refs/remotes/}"; then
    printf '%s\n' "$input_ref"
    return
  fi
  if git show-ref --verify --quiet "refs/heads/$input_ref"; then
    printf '%s\n' "$input_ref"
    return
  fi
  if git show-ref --verify --quiet "refs/remotes/upstream/main"; then
    printf '%s\n' "upstream/main"
  else
    printf '%s\n' "origin/main"
  fi
}

changed_files_against_base() {
  local base_ref="$1"
  git diff --name-only --diff-filter=ACMR "$base_ref...HEAD"
}

is_system_file() {
  local path="$1"
  case "$path" in
    .autopr/* | AGENTS.md | CLAUDE.md | git-hooks/pre-push | scripts/task-start | scripts/task-verify | scripts/pr-guardrails.sh)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

find_system_files_in_diff() {
  local base_ref="$1"
  local found=1
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if is_system_file "$file"; then
      printf '%s\n' "$file"
      found=0
    fi
  done < <(changed_files_against_base "$base_ref")
  return "$found"
}

contains_system_paths() {
  local files=()
  while IFS= read -r f; do
    files+=("$f")
  done
  local f
  for f in "${files[@]}"; do
    if is_system_file "$f"; then
      return 0
    fi
  done
  return 1
}
