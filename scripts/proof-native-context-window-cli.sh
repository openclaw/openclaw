#!/usr/bin/env bash
set -euo pipefail

exec node scripts/run-vitest.mjs src/commands/agent-exec-plugin.e2e.test.ts \
  --config test/vitest/vitest.e2e.config.ts \
  --maxWorkers=1 \
  --testNamePattern='runs the CLI with context windows discovered by a native harness' \
  --reporter=verbose \
  --silent=false
