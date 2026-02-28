#!/usr/bin/env bash
set -euo pipefail

ROOT="${HEARTBEAT_ROOT:-$(pwd)}"
REPORT_DIR="${HEARTBEAT_REPORT_DIR:-$ROOT/reports}"
MAX_AGE_MIN="${MAX_AGE_MIN:-15}"
mkdir -p "$REPORT_DIR"
TS=$(date +%Y-%m-%d_%H-%M-%S)
OUT="$REPORT_DIR/heartbeat-freshness-$TS.md"
NOW=$(date +%s)

check() {
  local label="$1" path="$2"
  if [[ ! -f "$path" ]]; then
    echo "- ❌ $label: missing ($path)"
    return
  fi
  local mt age
  if mt=$(stat -f %m "$path" 2>/dev/null); then
    :
  elif mt=$(stat -c %Y "$path" 2>/dev/null); then
    :
  else
    echo "- ❌ $label: unable to read mtime ($path)"
    return
  fi
  age=$(( (NOW - mt) / 60 ))
  if (( age <= MAX_AGE_MIN )); then
    echo "- ✅ $label: ${age}m"
  else
    echo "- ⚠️ $label: ${age}m"
  fi
}

latest() { ls -1t $1 2>/dev/null | head -n 1 || true; }
pre=$(latest "$REPORT_DIR/heartbeat-preflight-*.md")
gua=$(latest "$REPORT_DIR/heartbeat-guard-*.md")

{
  echo "# Heartbeat Freshness"
  echo
  echo "Generated: $(date)"
  echo "Max age: ${MAX_AGE_MIN}m"
  echo
  check preflight "$pre"
  check guard "$gua"
} > "$OUT"

echo "$OUT"
