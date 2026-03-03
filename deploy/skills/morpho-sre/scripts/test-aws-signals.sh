#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/aws-resource-signals.sh"

output="$($SCRIPT 2>/dev/null || true)"
if [[ -z "$output" ]]; then
  echo "FAIL: expected output with TSV header"
  exit 1
fi

header="$(printf '%s\n' "$output" | head -n1)"
expected_header=$'resource_type\tresource_id\tstatus\tutilization_pct\tnotes'
if [[ "$header" != "$expected_header" ]]; then
  echo "FAIL: unexpected header: $header"
  exit 1
fi

echo "PASS: correct TSV header"

bad_line="$(printf '%s\n' "$output" | awk -F'\t' 'NF>0 && NF!=5 { print; exit }')"
if [[ -n "$bad_line" ]]; then
  echo "FAIL: malformed TSV line: $bad_line"
  exit 1
fi

echo "All aws-signals tests passed."
