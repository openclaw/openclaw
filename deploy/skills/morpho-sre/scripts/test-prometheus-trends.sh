#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/prometheus-trends.sh"

unset PROMETHEUS_URL
output="$($SCRIPT 2>/dev/null || true)"
if [[ -n "$output" ]]; then
  echo "FAIL: expected empty output when PROMETHEUS_URL unset"
  exit 1
fi
echo "PASS: empty output when PROMETHEUS_URL unset"

export PROMETHEUS_URL="http://127.0.0.1:9"
export SCOPE_NAMESPACES="morpho-dev"
output="$($SCRIPT 2>/dev/null || true)"
if [[ -z "$output" ]]; then
  echo "FAIL: expected TSV output/header when PROMETHEUS_URL set"
  exit 1
fi

header="$(printf '%s\n' "$output" | head -n1)"
expected_header=$'metric_name\tpod\tcurrent_value\t6h_trend\t24h_trend\tthreshold_proximity\tstatus'
if [[ "$header" != "$expected_header" ]]; then
  echo "FAIL: unexpected header: $header"
  exit 1
fi
echo "PASS: correct TSV header"

echo "All prometheus-trends tests passed."
