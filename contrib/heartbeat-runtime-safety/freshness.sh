#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT="${HEARTBEAT_ROOT:-$REPO_ROOT_DEFAULT}"
REPORT_DIR="${HEARTBEAT_REPORT_DIR:-$ROOT/reports}"
MAX_AGE_MIN="${MAX_AGE_MIN:-15}"
mkdir -p "$REPORT_DIR"
TS=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$REPORT_DIR/heartbeat-freshness-$TS.md"
NOW=$(date +%s)
status="PASS"

check() {
  local label="$1" path="$2"
  if [[ -z "$path" || ! -f "$path" ]]; then
    echo "- ❌ $label: missing"
    status="FAIL"
    return
  fi

  local mt age
  if mt=$(stat -f %m "$path" 2>/dev/null); then
    :
  elif mt=$(stat -c %Y "$path" 2>/dev/null); then
    :
  else
    echo "- ❌ $label: unable to read mtime ($path)"
    status="FAIL"
    return
  fi

  age=$(( (NOW - mt) / 60 ))
  if (( age <= MAX_AGE_MIN )); then
    echo "- ✅ $label: ${age}m"
  else
    echo "- ❌ $label: stale (${age}m > ${MAX_AGE_MIN}m)"
    status="FAIL"
  fi
}

latest() {
  local pattern="$1"
  local files=()
  shopt -s nullglob
  files=("$REPORT_DIR"/$pattern)
  shopt -u nullglob

  if (( ${#files[@]} == 0 )); then
    echo ""
    return
  fi

  ls -1t "${files[@]}" 2>/dev/null | head -n 1 || true
}

pre=$(latest "heartbeat-preflight-*.md")
gua=$(latest "heartbeat-guard-*.md")

{
  echo "# Heartbeat Freshness"
  echo
  echo "Generated: $(date)"
  echo "Root: $ROOT"
  echo "Max age: ${MAX_AGE_MIN}m"
  echo
  check preflight "$pre"
  check guard "$gua"
  echo
  echo "## Result"
  echo "- $status"
} > "$OUT"

echo "$OUT"
if [[ "$status" != "PASS" ]]; then
  exit 1
fi
