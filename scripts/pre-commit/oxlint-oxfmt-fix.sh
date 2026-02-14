#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
git_lock="$ROOT_DIR/.git/index.lock"
# Wait briefly for stale index.lock (e.g. left by detect-secrets baseline update)
for _i in 1 2 3 4 5; do
  [[ -f "$git_lock" ]] || break
  sleep 0.2
done
if [[ -f "$git_lock" ]]; then
  echo "[pre-commit] detected existing index.lock; skipping formatting hook to avoid loop"
  exit 0
fi

if [[ $# -eq 0 ]]; then
  exit 0
fi

run_tool="$ROOT_DIR/scripts/pre-commit/run-node-tool.sh"
for f in "$@"; do
  [[ -f "$f" ]] || continue
  "$run_tool" oxlint --fix -- "$f" 2>/dev/null || true
done
"$run_tool" oxfmt --write -- "$@"
# Retry git add in case index.lock is transiently held
for _try in 1 2 3; do
  git add -- "$@" && break
  sleep 0.3
done
