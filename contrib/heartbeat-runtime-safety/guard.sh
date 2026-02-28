#!/usr/bin/env bash
set -euo pipefail

ROOT="${HEARTBEAT_ROOT:-$(pwd)}"
REPORT_DIR="${HEARTBEAT_REPORT_DIR:-$ROOT/reports}"
mkdir -p "$REPORT_DIR"
TS=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$REPORT_DIR/heartbeat-guard-$TS.md"

commands=(
  "./contrib/heartbeat-runtime-safety/preflight.sh"
)

status="PASS"
{
  echo "# Heartbeat Failure Guard"
  echo
  echo "Generated: $(date)"
  echo
  echo "## Command Results"
  for cmd in "${commands[@]}"; do
    if (cd "$ROOT" && eval "$cmd" >/dev/null 2>&1); then
      echo "- ✅ $cmd"
    else
      echo "- ❌ $cmd"
      status="FAIL"
    fi
  done
  echo
  echo "## Overall"
  echo "- $status"
} > "$OUT"

echo "$OUT"
