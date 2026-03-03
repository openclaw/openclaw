#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/sentinel-triage.sh"

extract_function() {
  local fn="$1"
  sed -n "/^${fn}()[[:space:]]*{/,/^}/p" "$SCRIPT_PATH"
}

fail() {
  echo "FAIL: $*"
  exit 1
}

eval "$(extract_function split_csv_atoms)"
eval "$(extract_function normalize_pod_workload_name)"
eval "$(extract_function derive_step11_workloads)"

scopes="$(split_csv_atoms 'morpho-dev, monitoring , ,prod' | paste -sd',' -)"
[[ "$scopes" == "morpho-dev,monitoring,prod" ]] || fail "split_csv_atoms mismatch: $scopes"
echo "PASS: split_csv_atoms trims/splits scope list"

normalized="$(normalize_pod_workload_name 'api-gateway-7b5f8c9d4-xk2lm')"
[[ "$normalized" == "api-gateway" ]] || fail "pod normalization mismatch: $normalized"
echo "PASS: normalize_pod_workload_name strips pod suffixes"

derived="$(
  derive_step11_workloads \
    $'morpho-dev\tapi-gateway\t3\t2\t2\t1\n' \
    $'morpho-dev\tapi-gateway-7b5f8c9d4-xk2lm\tRunning\t5\tCrashLoopBackOff\n'
)"
[[ "$derived" == "api-gateway|" ]] || fail "derive_step11_workloads mismatch: $derived"
echo "PASS: derive_step11_workloads prefers deployment workload names"

echo "All context plumbing tests passed."
