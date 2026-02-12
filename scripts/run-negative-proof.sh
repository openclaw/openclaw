#!/usr/bin/env bash
#
# Negative Proof Runner for LLM Import Gates
#
# This script validates that our detection WORKS by ensuring
# each deliberately-bad fixture TRIGGERS a gate failure.
#
# If any fixture PASSES (no error), our detection has a gap
# and the negative proof fails.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FIXTURE_DIR="test/ci-gates/import-detection-fixtures"
CHECK_SCRIPT="scripts/check-llm-imports.sh"

PASSED=0
FAILED=0

echo "=== LLM Import Gates: Negative Proof ==="
echo "Validating that detection catches all bad patterns..."
echo

# Check fixture directory exists
if [[ ! -d "$FIXTURE_DIR" ]]; then
  echo "ERROR: Fixture directory not found: $FIXTURE_DIR"
  exit 1
fi

# Helper to get expected gate for a fixture
get_expected_gate() {
  local filename="$1"
  case "$filename" in
    fixture-sdk-import-openai.ts) echo "A" ;;
    fixture-sdk-import-anthropic.ts) echo "A" ;;
    fixture-require-openai.ts) echo "A" ;;
    fixture-dynamic-import.ts) echo "A" ;;
    fixture-deep-import.ts) echo "A" ;;
    fixture-embedded-runner-import.ts) echo "B" ;;
    fixture-embedded-runner-alias.ts) echo "B" ;;
    fixture-raw-http-openai.ts) echo "C" ;;
    fixture-raw-http-anthropic.ts) echo "C" ;;
    *) echo "UNKNOWN" ;;
  esac
}

# Check each fixture
for fixture in "$FIXTURE_DIR"/*.ts; do
  if [[ ! -f "$fixture" ]]; then
    continue
  fi
  
  filename=$(basename "$fixture")
  expected_gate=$(get_expected_gate "$filename")
  
  printf "Testing %-40s (Gate %s)... " "$filename" "$expected_gate"
  
  # Run the checker on this single fixture
  # We expect it to FAIL (exit non-zero)
  if "$CHECK_SCRIPT" "$fixture" >/dev/null 2>&1; then
    echo "NEGATIVE PROOF FAILED!"
    echo "  Fixture should have triggered Gate $expected_gate but was NOT detected."
    FAILED=$((FAILED + 1))
  else
    echo "OK (correctly detected)"
    PASSED=$((PASSED + 1))
  fi
done

echo
echo "=== Negative Proof Results ==="
echo "Passed: $PASSED"
echo "Failed: $FAILED"

if [[ "$FAILED" -gt 0 ]]; then
  echo
  echo "NEGATIVE PROOF FAILED"
  echo "Detection has gaps - some bad patterns are not being caught."
  exit 1
fi

if [[ "$PASSED" -eq 0 ]]; then
  echo
  echo "WARNING: No fixtures tested. Check fixture directory."
  exit 1
fi

echo
echo "All negative proofs passed - detection is working correctly."
