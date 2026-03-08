#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_REPORT_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_REPORT_DIR"' EXIT

cd "$SCRIPT_DIR"

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

run_test "preflight runs" env HEARTBEAT_ROOT="$REPO_ROOT" HEARTBEAT_REPORT_DIR="$TMP_REPORT_DIR" ./preflight.sh
run_test "guard runs" env HEARTBEAT_ROOT="$REPO_ROOT" HEARTBEAT_REPORT_DIR="$TMP_REPORT_DIR" ./guard.sh
run_test "freshness runs" env HEARTBEAT_ROOT="$REPO_ROOT" HEARTBEAT_REPORT_DIR="$TMP_REPORT_DIR" ./freshness.sh

if [[ $fail -gt 0 ]]; then
  echo "Tests failed: $fail"
  exit 1
fi

echo "All tests passed: $pass"
