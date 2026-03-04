#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-outbox.sh
source "${SCRIPT_DIR}/lib-outbox.sh"

PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  [[ "$expected" == "$actual" ]] || fail "$msg (expected: $expected; got: $actual)"
}

CLAIM1="$(outbox_claim_attempt 2 2 pending 0)"
assert_eq $'claimed\tpending\t1' "$CLAIM1" "claim first attempt"
FINAL1="$(outbox_finalize 2 2 pending 1 0)"
assert_eq $'sent\tsent\t1' "$FINAL1" "finalize sent"
pass "pending -> sent"

STATUS="pending"
ATTEMPTS=0
for _n in 1 2; do
  CLAIM="$(outbox_claim_attempt 3 3 "$STATUS" "$ATTEMPTS")"
  STATUS="$(printf '%s\n' "$CLAIM" | awk -F'\t' '{print $2}')"
  ATTEMPTS="$(printf '%s\n' "$CLAIM" | awk -F'\t' '{print $3}')"
  FINAL="$(outbox_finalize 3 3 "$STATUS" "$ATTEMPTS" 1)"
  STATUS="$(printf '%s\n' "$FINAL" | awk -F'\t' '{print $2}')"
  ATTEMPTS="$(printf '%s\n' "$FINAL" | awk -F'\t' '{print $3}')"
done
CLAIM3="$(outbox_claim_attempt 3 3 "$STATUS" "$ATTEMPTS")"
ATTEMPTS3="$(printf '%s\n' "$CLAIM3" | awk -F'\t' '{print $3}')"
FINAL3="$(outbox_finalize 3 3 "$STATUS" "$ATTEMPTS3" 1)"
assert_eq $'failed_terminal\tfailed_terminal\t3' "$FINAL3" "terminal after max attempts"
pass "retry -> terminal"

STALE_CLAIM="$(outbox_claim_attempt 2 3 pending 0)"
assert_eq $'stale\tpending\t0' "$STALE_CLAIM" "stale claim"
STALE_FINAL="$(outbox_finalize 2 3 pending 1 0)"
assert_eq $'stale\tpending\t1' "$STALE_FINAL" "stale finalize"
pass "version-keyed stale guard"

CRASH_CLAIM="$(outbox_claim_attempt 5 5 pending 0)"
assert_eq $'claimed\tpending\t1' "$CRASH_CLAIM" "claim before crash"
# Simulate crash before finalize: persisted state is pending + attempts=1.
RETRY_CLAIM="$(outbox_claim_attempt 5 5 pending 1)"
assert_eq $'claimed\tpending\t2' "$RETRY_CLAIM" "retry after crash-window"
pass "crash-window idempotency"

if outbox_should_alert_terminal failed_retryable failed_terminal; then
  :
else
  fail "terminal transition should alert"
fi
if outbox_should_alert_terminal failed_terminal failed_terminal; then
  fail "repeat terminal should not alert"
fi
pass "terminal alert hook"

succeed_cmd() { return 0; }
fail_cmd() { return 1; }
RUN_OK="$(outbox_run_delivery 7 7 pending 0 succeed_cmd)"
assert_eq $'sent\tsent\t1' "$RUN_OK" "run delivery success"
RUN_FAIL="$(outbox_run_delivery 7 7 pending 2 fail_cmd)"
assert_eq $'failed_terminal\tfailed_terminal\t3' "$RUN_FAIL" "run delivery failure terminal"
pass "run delivery helper"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
