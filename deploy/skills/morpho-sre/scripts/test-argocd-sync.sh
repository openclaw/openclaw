#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/argocd-sync-status.sh"

unset ARGOCD_BASE_URL
output="$($SCRIPT 2>/dev/null || true)"
if [[ -n "$output" ]]; then
  echo "FAIL: expected empty output when ARGOCD_BASE_URL unset"
  exit 1
fi
echo "PASS: empty output when ARGOCD_BASE_URL unset"

export ARGOCD_BASE_URL="http://127.0.0.1:9"
export ARGOCD_AUTH_TOKEN="test-token"
export SCOPE_NAMESPACES="morpho-dev"
output="$($SCRIPT 2>/dev/null || true)"
if [[ -z "$output" ]]; then
  echo "FAIL: expected TSV output/header when ARGOCD_BASE_URL set"
  exit 1
fi

header="$(printf '%s\n' "$output" | head -n1)"
expected_header=$'app_name\tsync_status\thealth_status\tlast_sync_time\tlast_sync_result\tdrift_summary'
if [[ "$header" != "$expected_header" ]]; then
  echo "FAIL: unexpected header: $header"
  exit 1
fi
echo "PASS: correct TSV header"

echo "All argocd-sync tests passed."
