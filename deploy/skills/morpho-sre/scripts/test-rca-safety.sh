#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-rca-safety.sh
source "${SCRIPT_DIR}/lib-rca-safety.sh"

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

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
RCA_SAFETY_DIR="$TMP_DIR"
RCA_CONVERGENCE_FILE="${TMP_DIR}/rca-convergence-stats.tsv"
RCA_MODE_STATE_FILE="${TMP_DIR}/rca-mode-state.tsv"
RCA_SAFETY_LOCK_FILE="${TMP_DIR}/rca-safety.lock"

rca_safety_init

BASE=1700000000
# 10 samples in 7d; 4 not converged => 40% (downgrade trigger)
for i in 0 1 2 3; do
  rca_safety_record_outcome $((BASE + i)) not_converged
done
for i in 4 5 6 7 8 9; do
  rca_safety_record_outcome $((BASE + i)) converged
done

UPDATE1="$(rca_safety_update_state "$BASE")"
STATE1="$(printf '%s\n' "$UPDATE1" | awk -F'\t' '$1=="state" {print $2}')"
TRANS1="$(printf '%s\n' "$UPDATE1" | awk -F'\t' '$1=="transition" {print $2}')"
assert_eq "downgraded" "$STATE1" "downgrade state"
assert_eq "enter_downgrade" "$TRANS1" "downgrade transition"
pass "downgrade trigger"

# Recovery case: 14d rate <15% with >=10 samples
: >"$RCA_CONVERGENCE_FILE"
printf '#v1\tts\toutcome\n' >"$RCA_CONVERGENCE_FILE"
for i in 0 1 2 3 4 5 6 7 8; do
  rca_safety_record_outcome $((BASE + 100 + i)) converged
done
rca_safety_record_outcome $((BASE + 200)) not_converged
UPDATE2="$(rca_safety_update_state $((BASE + 200)))"
STATE2="$(printf '%s\n' "$UPDATE2" | awk -F'\t' '$1=="state" {print $2}')"
TRANS2="$(printf '%s\n' "$UPDATE2" | awk -F'\t' '$1=="transition" {print $2}')"
assert_eq "normal" "$STATE2" "recovery state"
assert_eq "exit_downgrade" "$TRANS2" "recovery transition"
pass "recovery by low 14d rate"

# Force downgraded with <10 samples for recovery via insufficient evidence
printf '#v1\tstate\tupdated_ts\tlast_probe_ts\nrow\tdowngraded\t1700000000\t0\n' >"$RCA_MODE_STATE_FILE"
: >"$RCA_CONVERGENCE_FILE"
printf '#v1\tts\toutcome\n' >"$RCA_CONVERGENCE_FILE"
for i in 0 1 2 3 4; do
  rca_safety_record_outcome $((BASE + 300 + i)) not_converged
done
UPDATE3="$(rca_safety_update_state $((BASE + 300)))"
STATE3="$(printf '%s\n' "$UPDATE3" | awk -F'\t' '$1=="state" {print $2}')"
assert_eq "normal" "$STATE3" "recovery when <10 samples"
pass "recovery by low sample count"

# Daily probe while downgraded.
printf '#v1\tstate\tupdated_ts\tlast_probe_ts\nrow\tdowngraded\t1700000000\t0\n' >"$RCA_MODE_STATE_FILE"
: >"$RCA_CONVERGENCE_FILE"
printf '#v1\tts\toutcome\n' >"$RCA_CONVERGENCE_FILE"
for i in 0 1 2 3 4; do
  rca_safety_record_outcome $((BASE + 400 + i)) not_converged
done
for i in 5 6 7 8 9; do
  rca_safety_record_outcome $((BASE + 400 + i)) converged
done
MODE1="$(rca_safety_effective_mode dual medium $((BASE + 90000)))"
assert_eq "dual_probe" "$MODE1" "first daily probe allowed"
MODE2="$(rca_safety_effective_mode dual medium $((BASE + 90500)))"
assert_eq "single" "$MODE2" "second run same day forced single"
MODE3="$(rca_safety_effective_mode dual low $((BASE + 200000)))"
assert_eq "single" "$MODE3" "low severity stays single while downgraded"
pass "daily probe behavior"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
