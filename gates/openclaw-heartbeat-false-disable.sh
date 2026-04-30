#!/usr/bin/env bash
set -euo pipefail
# GATE_LEVEL: P1
# GATE_VERIFY: heartbeat false disables heartbeat config parsing and runtime helpers
cd /Users/karlkarl/Documents/vibe_coding/openclaw-upstream
node scripts/run-vitest.mjs run --config test/vitest/vitest.runtime-config.config.ts src/config/zod-schema.agent-defaults.test.ts src/config/config.pruning-defaults.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.infra.config.ts src/infra/heartbeat-runner.returns-default-unset.test.ts
