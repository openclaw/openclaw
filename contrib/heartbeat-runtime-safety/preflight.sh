#!/usr/bin/env bash
set -euo pipefail

ROOT="${HEARTBEAT_ROOT:-$(pwd)}"
REPORT_DIR="${HEARTBEAT_REPORT_DIR:-$ROOT/reports}"
mkdir -p "$REPORT_DIR"
TS=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$REPORT_DIR/heartbeat-preflight-$TS.md"

required=(
  "HEARTBEAT.md"
  "TASKS.md"
)

status="PASS"
{
  echo "# Heartbeat Runtime Preflight"
  echo
  echo "Generated: $(date)"
  echo
  echo "## Checks"
  for f in "${required[@]}"; do
    if [[ -e "$ROOT/$f" ]]; then
      echo "- ✅ $f"
    else
      echo "- ❌ $f (missing)"
      status="FAIL"
    fi
  done
  echo
  echo "## Result"
  echo "- $status"
} > "$OUT"

echo "$OUT"
