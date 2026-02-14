#!/usr/bin/env bash
# Run tests only for changed files
set -euo pipefail

CHANGED=$(git diff --name-only HEAD~1 -- 'src/agents/*.ts' 'src/tui/*.ts' | head -20)
if [ -z "$CHANGED" ]; then
  echo "🌿 No agent/tui changes, skipping tests"
  exit 0
fi

echo "🌿 Running tests for changed files..."
# Find corresponding test files
TEST_FILES=""
for f in $CHANGED; do
  TEST="${f%.ts}.test.ts"
  if [ -f "$TEST" ]; then
    TEST_FILES="$TEST_FILES $TEST"
  fi
done

if [ -n "$TEST_FILES" ]; then
  npx vitest run $TEST_FILES --reporter=verbose
else
  echo "No test files found for changes, running all agent tests..."
  npx vitest run src/agents/ --reporter=verbose
fi
