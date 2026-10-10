#!/usr/bin/env bash
set -euo pipefail

# Compare against one fetched snapshot, without executing candidate code.
repository_url="$1"
context_ref="$2"
target_sha="$3"
relationship="${4:-exact}"
context_repo="$(mktemp -d)"
trap 'rm -rf -- "$context_repo"' EXIT
git init --bare --quiet "$context_repo"
if ! GIT_TERMINAL_PROMPT=0 git -C "$context_repo" fetch --quiet --no-tags --filter=blob:none \
  "$repository_url" "$context_ref"; then
  echo "Failed to fetch trusted QA tooling context ${context_ref}." >&2
  exit 1
fi
context_sha="$(git -C "$context_repo" rev-parse --verify 'FETCH_HEAD^{commit}')"
target_sha="$(printf '%s' "$target_sha" | tr '[:upper:]' '[:lower:]')"
case "$context_ref:$relationship" in
  refs/heads/*:ancestor)
    if ! git -C "$context_repo" merge-base --is-ancestor "$target_sha" "$context_sha" 2>/dev/null; then
      echo "Target ${target_sha} is not reachable from branch ${context_ref} at ${context_sha}." >&2
      exit 1
    fi
    ;;
  refs/heads/*:exact|refs/tags/*:exact|refs/tags/*:ancestor)
    if [[ "$context_sha" != "$target_sha" ]]; then
      echo "Release context ${context_ref} resolves to ${context_sha} and does not match target ${target_sha}." >&2
      exit 1
    fi
    ;;
  *) exit 1 ;;
esac
