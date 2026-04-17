#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

WITH_INSTALL_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --with-install-smoke)
      WITH_INSTALL_SMOKE=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: scripts/pre-pr-memory-check.sh [--with-install-smoke]" >&2
      exit 2
      ;;
  esac
done

log_step() {
  printf '\n==> %s\n' "$*"
}

run_step() {
  log_step "$*"
  "$@"
}

run_step pnpm vitest run \
  extensions/memory-core/src/tools.citations.test.ts \
  extensions/memory-wiki/src/query.test.ts \
  extensions/memory-wiki/src/config.test.ts \
  extensions/memory-wiki/src/status.test.ts \
  src/plugins/tools.optional.test.ts \
  test/extension-import-boundaries.test.ts \
  src/channels/plugins/contracts/channel-import-guardrails.test.ts

run_step pnpm check

if [[ "$WITH_INSTALL_SMOKE" == "1" ]]; then
  run_step bash scripts/test-install-sh-docker.sh
fi

log_step "pre-PR memory gate passed"
