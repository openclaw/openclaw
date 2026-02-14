#!/usr/bin/env bash
# gclaw local CI — runs on small machines (8GB RAM, no GPU)
# Usage: ./scripts/local-ci.sh [--quick|--full]
#
# --quick (default): unit tests only, no type check, <2 min
# --full: unit tests + type check + lint, ~5-10 min on slow machines
#
# Exit codes:
#   0 = all passed
#   1 = tests failed
#   2 = lint failed
#   3 = type check failed

set -euo pipefail

MODE="${1:---quick}"

echo "🌿 gclaw local CI ($MODE)"
echo "================================"

# Detect resources
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
CPU_CORES=$(nproc)
echo "System: ${TOTAL_RAM_MB}MB RAM, ${CPU_CORES} cores"

# Always run unit tests (fast, low memory)
echo ""
echo "📋 Running unit tests..."
# Use --pool=forks on low-memory machines to avoid VM overhead
if [ "$TOTAL_RAM_MB" -lt 12000 ]; then
  POOL_FLAG="--pool=forks --poolOptions.forks.maxForks=2"
else
  POOL_FLAG=""
fi
npx vitest run src/agents/ $POOL_FLAG --reporter=verbose

if [ "$MODE" = "--full" ]; then
  echo ""
  echo "🔍 Running linter..."
  npx eslint src/agents/ --max-warnings=0 || exit 2

  echo ""
  echo "📐 Type checking (this takes a while on small machines)..."
  npx tsc --noEmit || exit 3
fi

echo ""
echo "🌿 All checks passed!"
