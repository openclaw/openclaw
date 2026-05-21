#!/usr/bin/env bash
# assert-worktree.sh -- guard for fleet cascade role-agents.
#
# Cascade role-agents must operate inside per-cascade /tmp worktrees, not the
# canonical ~/Pebble/github/rockie/<repo> checkouts. Run directly as:
#
#   bash scripts/lib/assert-worktree.sh

# shellcheck source=sibling-repos.sh
source "$(dirname "${BASH_SOURCE[0]}")/sibling-repos.sh"

assert_cascade_worktree() {
  local resolved canonical_root canonical_path sibling
  resolved="$(pwd -P)"
  canonical_root="${HOME}/Pebble/github/rockie"

  for sibling in "${CANONICAL_SIBLINGS[@]}"; do
    canonical_path="${canonical_root}/${sibling}"
    if [[ -d "$canonical_path" ]]; then
      canonical_path="$(cd "$canonical_path" 2>/dev/null && pwd -P)" \
        || canonical_path="${canonical_root}/${sibling}"
    fi
    if [[ "$resolved" == "$canonical_path" || "$resolved" == "$canonical_path"/* ]]; then
      printf '\n!!! WORKTREE CONTRACT VIOLATION !!!\n' >&2
      printf 'pwd -P resolves under canonical sibling root:\n' >&2
      printf '  pwd:       %s\n' "$resolved" >&2
      printf '  canonical: %s\n' "$canonical_path" >&2
      printf 'Cascade role-agents must operate in a per-cascade /tmp worktree.\n\n' >&2
      return 1
    fi
  done

  # Accept lane-A worktrees ending in a numeric pid and lane-b/c/d worktrees
  # ending in lane-<letter>, including sibling repo names in the middle.
  if [[ "$resolved" =~ ^/(private/)?tmp/rockie-cascade-[0-9]+(-(platform|rockie)-[a-z0-9]+)*-([0-9]+|lane-[a-z]+)(/.*)?$ ]]; then
    return 0
  fi

  printf '\n!!! WORKTREE CONTRACT VIOLATION !!!\n' >&2
  printf 'pwd -P is not a per-cascade /tmp worktree:\n' >&2
  printf '  pwd: %s\n' "$resolved" >&2
  printf 'Expected /tmp/rockie-cascade-<issue>-(<pid>|lane-<x>) or /tmp/rockie-cascade-<issue>-<repo>-(<pid>|lane-<x>).\n\n' >&2
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  assert_cascade_worktree
  exit $?
fi
