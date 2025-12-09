#!/usr/bin/env bash

set -euo pipefail
# Disable glob expansion to handle brackets in file paths
set -f
usage() {
  printf 'Usage: %s [--force] "commit message" "file" ["file" ...]\n' "$(basename "$0")" >&2
  exit 2
}

if [ "$#" -lt 2 ]; then
  usage
fi

force_delete_lock=false
if [ "${1:-}" = "--force" ]; then
  force_delete_lock=true
  shift
fi

if [ "$#" -lt 2 ]; then
  usage
fi

commit_message=$1
shift

if [[ "$commit_message" != *[![:space:]]* ]]; then
  printf 'Error: commit message must not be empty\n' >&2
  exit 1
fi

if [ -e "$commit_message" ]; then
  printf 'Error: first argument looks like a file path ("%s"); provide the commit message first\n' "$commit_message" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  usage
fi

files=("$@")

# Disallow "." because it stages the entire repository and defeats the helper's safety guardrails.
for file in "${files[@]}"; do
  if [ "$file" = "." ]; then
    printf 'Error: "." is not allowed; list specific paths instead\n' >&2
    exit 1
  fi
done

last_commit_error=''

run_git_commit() {
  local stderr_log
  stderr_log=$(mktemp)
  if git commit -m "$commit_message" -- "${files[@]}" 2> >(tee "$stderr_log" >&2); then
    rm -f "$stderr_log"
    last_commit_error=''
    return 0
  fi

  last_commit_error=$(cat "$stderr_log")
  rm -f "$stderr_log"
  return 1
}

for file in "${files[@]}"; do
  if [ ! -e "$file" ]; then
    if ! git ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
      printf 'Error: file not found: %s\n' "$file" >&2
      exit 1
    fi
  fi
done

git restore --staged :/
git add --force -- "${files[@]}"

if git diff --staged --quiet; then
  printf 'Warning: no staged changes detected for: %s\n' "${files[*]}" >&2
  exit 1
fi

committed=false
if run_git_commit; then
  committed=true
elif [ "$force_delete_lock" = true ]; then
  lock_path=$(
    printf '%s\n' "$last_commit_error" |
      awk -F"'" '/Unable to create .*\.git\/index\.lock/ { print $2; exit }'
  )

  if [ -n "$lock_path" ] && [ -e "$lock_path" ]; then
    rm -f "$lock_path"
    printf 'Removed stale git lock: %s\n' "$lock_path" >&2
    if run_git_commit; then
      committed=true
    fi
  fi
fi

if [ "$committed" = false ]; then
  exit 1
fi

printf 'Committed "%s" with %d files\n' "$commit_message" "${#files[@]}"
