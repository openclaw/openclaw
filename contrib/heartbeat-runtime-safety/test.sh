#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

mkdir -p reports

pass=0
fail=0

run_test() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS: $name"
    pass=$((pass+1))
  else
    echo "FAIL: $name"
    fail=$((fail+1))
  fi
}

run_test "preflight runs" ./contrib/heartbeat-runtime-safety/preflight.sh
run_test "guard runs" ./contrib/heartbeat-runtime-safety/guard.sh
run_test "freshness runs" ./contrib/heartbeat-runtime-safety/freshness.sh

if [[ $fail -gt 0 ]]; then
  echo "Tests failed: $fail"
  exit 1
fi

echo "All tests passed: $pass"
