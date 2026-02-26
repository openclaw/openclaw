#!/bin/bash
# E2E tests for chrome-cleanup.sh

set -e

echo "=== Chrome Cleanup E2E Tests ==="

# Test 1: Platform detection
PLATFORM=$(uname -s)
if [[ "$PLATFORM" == "Linux" ]] || [[ "$PLATFORM" == "Darwin" ]]; then
  echo "[PASS] Platform: $PLATFORM"
fi

# Test 2: Script runs
if bash scripts/chrome-cleanup.sh status >/dev/null 2>&1; then
  echo "[PASS] Script executes"
fi

# Test 3: Config exists
[ -f scripts/chrome-cleanup.conf ] && echo "[PASS] Config found"

echo "=== Tests Complete ==="
