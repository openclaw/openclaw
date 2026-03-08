#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT="${HEARTBEAT_ROOT:-$REPO_ROOT_DEFAULT}"
REPORT_DIR="${HEARTBEAT_REPORT_DIR:-$ROOT/reports}"
mkdir -p "$REPORT_DIR"
TS=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$REPORT_DIR/heartbeat-preflight-$TS.md"

# Comma-separated relative paths can be provided via REQUIRED_PATHS.
# Keep defaults minimal and repo-agnostic.
REQUIRED_PATHS_RAW="${REQUIRED_PATHS:-contrib/heartbeat-runtime-safety/preflight.sh,contrib/heartbeat-runtime-safety/guard.sh,contrib/heartbeat-runtime-safety/freshness.sh}"
IFS=',' read -r -a required <<< "$REQUIRED_PATHS_RAW"

status="PASS"
{
  echo "# Heartbeat Runtime Preflight"
  echo
  echo "Generated: $(date)"
  echo "Root: $ROOT"
  echo
  echo "## Checks"
  for f in "${required[@]}"; do
    f_trimmed="$(echo "$f" | xargs)"
    if [[ -e "$ROOT/$f_trimmed" ]]; then
      echo "- ✅ $f_trimmed"
    else
      echo "- ❌ $f_trimmed (missing)"
      status="FAIL"
    fi
  done
  echo
  echo "## Result"
  echo "- $status"
} > "$OUT"

echo "$OUT"
if [[ "$status" != "PASS" ]]; then
  exit 1
fi
