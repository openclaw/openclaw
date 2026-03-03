#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/sentinel-triage.sh"

extract_function() {
  local fn="$1"
  sed -n "/^${fn}()[[:space:]]*{/,/^}/p" "$SCRIPT_PATH"
}

log() {
  :
}

eval "$(extract_function acquire_lease)"
eval "$(extract_function release_lease)"
eval "$(extract_function abandon_lease)"

fail() {
  echo "FAIL: $*"
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SPOOL_DIR="$TMP_DIR/spool"
mkdir -p "$SPOOL_DIR"
STEP_LEASE_TTL_SECONDS=300
LEASE_DIR=""

key="lease-test-key"

acquire_lease "$key" || fail "first acquire should succeed"
[[ -n "$LEASE_DIR" ]] || fail "LEASE_DIR should be set"
[[ -f "$LEASE_DIR/owner" ]] || fail "owner token missing"
echo "PASS: first acquire succeeds"

if acquire_lease "$key"; then
  fail "second acquire should fail while lease held"
fi
echo "PASS: second acquire blocked"

release_lease "$key"
[[ -f "$SPOOL_DIR/${key}.done" ]] || fail ".done marker missing after release"
[[ -z "$LEASE_DIR" ]] || fail "LEASE_DIR should be cleared on release"
echo "PASS: release writes done marker"

if acquire_lease "$key"; then
  fail "acquire should fail when .done exists"
fi
echo "PASS: done marker blocks reacquire"

rm -f "$SPOOL_DIR/${key}.done"
mkdir -p "$SPOOL_DIR/lease-${key}"
old_ts=$(( $(date +%s) - 600 ))
printf 'host:%s\n' "$old_ts" > "$SPOOL_DIR/lease-${key}/owner"

acquire_lease "$key" || fail "stale lease should be reclaimed"
[[ -n "$LEASE_DIR" ]] || fail "LEASE_DIR should be set after stale reclaim"
echo "PASS: stale lease reclaimed"

abandon_lease "$key"
[[ ! -d "$SPOOL_DIR/lease-${key}" ]] || fail "lease dir should be removed"

echo

echo "All early lease tests passed."
