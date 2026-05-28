#!/usr/bin/env bash
# Guard agent launchers from starting in the default checkout with write intent.
# Usage: scripts/agent-launcher-cwd-guard.sh --intent write [--auto-worktree <slug>]
#
# With --auto-worktree: redirects to a new worktree instead of failing.
# Without: fails with an error message.

set -euo pipefail

INTENT=""
AUTO_WORKTREE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --intent) INTENT="$2"; shift 2 ;;
    --auto-worktree) AUTO_WORKTREE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")"

# Check if we're in a worktree
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || echo ".git")"
IS_WORKTREE="false"
[[ -f "$GIT_DIR" ]] && IS_WORKTREE="true"

# Only guard main branch at repo root
if [[ "$BRANCH" != "main" ]] || [[ "$IS_WORKTREE" == "true" ]]; then
  # Not the default checkout — allow
  echo "$ROOT_DIR"
  exit 0
fi

if [[ "$INTENT" != "write" ]]; then
  # Read intent — allow
  echo "$ROOT_DIR"
  exit 0
fi

# Write intent on default checkout
if [[ -n "$AUTO_WORKTREE" ]]; then
  WORKTREE_PATH="$("$ROOT_DIR/scripts/worktree-start.sh" "$AUTO_WORKTREE")"
  echo "$WORKTREE_PATH"
  exit 0
fi

echo "❌ Agent launcher blocked: write intent on default checkout (main)" >&2
echo "" >&2
echo "Options:" >&2
echo "  --auto-worktree <slug>  Create and redirect to a new worktree" >&2
echo "  Use scripts/worktree-start.sh <slug> manually" >&2
exit 1
