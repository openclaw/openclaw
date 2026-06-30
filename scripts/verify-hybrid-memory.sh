#!/usr/bin/env bash
set -euo pipefail

# Hybrid/QMD/Mem0 最小驗證腳本

echo "==> 檢查核心型別與實作存在"
rg "MemoryBackend = \"builtin\" \| \"qmd\" \| \"mem0\" \| \"hybrid\"" "src/config/types.memory.ts"
rg "class HybridMemoryManager|class Mem0MemoryManager" "extensions/memory-core/src/memory"

echo "==> 跑最小測試集（Hybrid/QMD/Mem0）"
node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-memory.config.ts \
  extensions/memory-core/index.test.ts \
  extensions/memory-core/src/memory/search-manager.test.ts

node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts \
  packages/memory-host-sdk/src/host/backend-config.test.ts \
  src/config/plugin-auto-enable.core.test.ts

node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts \
  src/gateway/server-startup-memory.test.ts

echo "==> 驗證完成"
