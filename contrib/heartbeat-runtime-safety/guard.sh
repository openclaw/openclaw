#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT="${HEARTBEAT_ROOT:-$REPO_ROOT_DEFAULT}"
REPORT_DIR="${HEARTBEAT_REPORT_DIR:-$ROOT/reports}"
mkdir -p "$REPORT_DIR"
TS=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$REPORT_DIR/heartbeat-guard-$TS.md"

status="PASS"
{
  echo "# Heartbeat Failure Guard"
  echo
  echo "Generated: $(date)"
  echo "Root: $ROOT"
  echo
  echo "## Command Results"

  if HEARTBEAT_ROOT="$ROOT" HEARTBEAT_REPORT_DIR="$REPORT_DIR" "$SCRIPT_DIR/preflight.sh" >/dev/null 2>&1; then
    echo "- ✅ preflight.sh"
  else
    echo "- ❌ preflight.sh"
    status="FAIL"
  fi

  echo
  echo "## Overall"
  echo "- $status"
} > "$OUT"

echo "$OUT"
if [[ "$status" != "PASS" ]]; then
  exit 1
fi
