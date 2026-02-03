#!/bin/bash
# View suppressed test logs from the most recent test run
# Usage: ./scripts/view-test-logs.sh [--follow]

set -euo pipefail

TMPDIR="${TMPDIR:-/tmp}"
FOLLOW_MODE=false

if [[ "${1:-}" == "--follow" ]] || [[ "${1:-}" == "-f" ]]; then
  FOLLOW_MODE=true
fi

# Find the most recent clawdbrain test log file
LATEST_LOG=$(ls -t "$TMPDIR"/clawdbrain-test-*.log 2>/dev/null | head -1)

if [[ -z "$LATEST_LOG" ]]; then
  echo "No test log files found in $TMPDIR"
  echo "Test logs are only created when CLAWDBRAIN_TEST_LOGS is not set (suppressed mode)."
  exit 1
fi

echo "Viewing test log: $LATEST_LOG"
echo "---"

if [[ "$FOLLOW_MODE" == "true" ]]; then
  tail -f "$LATEST_LOG"
else
  cat "$LATEST_LOG"
fi
