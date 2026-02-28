#!/usr/bin/env bash
set -euo pipefail

ROOT="${HEARTBEAT_ROOT:-$(pwd)}"
REPORT_DIR="${HEARTBEAT_REPORT_DIR:-$ROOT/reports}"
mkdir -p "$REPORT_DIR"
TS=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$REPORT_DIR/heartbeat-guard-$TS.md"

status="PASS"
{
  echo "# Heartbeat Failure Guard"
  echo
  echo "Generated: $(date)"
  echo
  echo "## Command Results"

  if (cd "$ROOT" && ./contrib/heartbeat-runtime-safety/preflight.sh >/dev/null 2>&1); then
    echo "- ✅ ./contrib/heartbeat-runtime-safety/preflight.sh"
  else
    echo "- ❌ ./contrib/heartbeat-runtime-safety/preflight.sh"
    status="FAIL"
  fi

  echo
  echo "## Overall"
  echo "- $status"
} > "$OUT"

echo "$OUT"
