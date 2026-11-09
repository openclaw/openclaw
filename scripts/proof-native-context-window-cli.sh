#!/usr/bin/env bash
set -euo pipefail

exec pnpm test src/commands/agent-exec-plugin.e2e.test.ts \
  --maxWorkers=1 \
  --testNamePattern='runs the CLI with context windows discovered by a native harness' \
  --reporter=verbose \
  --silent=false
