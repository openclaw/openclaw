#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if command -v pnpm >/dev/null 2>&1; then
  exec pnpm exec tsx scripts/e2e/parallels/macos-smoke.ts "$@"
fi
exec node --import tsx scripts/e2e/parallels/macos-smoke.ts "$@"
