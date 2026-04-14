#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    exec pnpm exec "$tool" "$@"
  fi
  if command -v corepack >/dev/null 2>&1 && [[ -f "$ROOT_DIR/package.json" ]]; then
    package_manager="$(node -e "const p=require(process.argv[1]); process.stdout.write(typeof p.packageManager==='string' ? p.packageManager : '')" "$ROOT_DIR/package.json" 2>/dev/null || true)"
    if [[ "$package_manager" == pnpm@* ]]; then
      exec corepack pnpm exec "$tool" "$@"
    fi
  fi
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

echo "Missing package manager: pnpm (or Corepack-managed pnpm), bun, or npm required." >&2
exit 1
