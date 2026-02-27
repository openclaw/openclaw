#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
REG="$ROOT/.clawdbot/active-tasks.json"

jq '.tasks |= map(select(.status != "merged" and .status != "failed_permanent"))' "$REG" > "$REG.tmp" && mv "$REG.tmp" "$REG"

git worktree prune

echo "Cleanup completed"
