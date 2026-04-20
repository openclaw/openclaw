#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMON_ROOT="$ROOT_DIR"

if common_git_dir=$(git -C "$ROOT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  COMMON_ROOT="$(cd "$(dirname "$common_git_dir")" && pwd)"
fi

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

for candidate_root in "$ROOT_DIR" "$COMMON_ROOT"; do
  candidate_bin="$candidate_root/node_modules/.bin/$tool"
  if [[ -x "$candidate_bin" ]]; then
    exec "$candidate_bin" "$@"
  fi
done

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  exec pnpm exec "$tool" "$@"
fi

if { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
  exec bunx --bun "$tool" "$@"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm exec -- "$tool" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx "$tool" "$@"
fi

echo "Missing package manager: pnpm, bun, or npm required." >&2
exit 1
