#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: run-pnpm-command.sh <pnpm-args...>" >&2
  exit 2
fi

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  exec pnpm "$@"
fi

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v corepack >/dev/null 2>&1; then
  if corepack pnpm --version >/dev/null 2>&1; then
    exec corepack pnpm "$@"
  fi
fi

echo "Missing package manager: pnpm or corepack pnpm required." >&2
exit 1
