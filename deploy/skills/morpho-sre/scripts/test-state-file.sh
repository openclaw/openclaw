#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-state-file.sh
source "${SCRIPT_DIR}/lib-state-file.sh"

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

assert_true() {
  local msg="$1"
  shift
  "$@" || fail "$msg"
}

make_row() {
  local id="$1"
  local ns="${2:-morpho-dev}"
  local category="${3:-resource_exhaustion}"
  local first_seen="${4:-1700000000}"
  local last_seen="${5:-1700000600}"
  local last_nonempty="${6:-1700000600}"
  local version="${7:-1}"
  local fingerprint="${8:-fp123abc}"
  local keys="${9:-step01:oom|step02:crashloop}"
  local linear_ticket="${10:-}"
  local thread_ts="${11:-1711111111.000100}"
  local workloads="${12:-api|worker}"
  local drift="${13:-1700000500:config_drift}"
  local slack_status="${14:-pending}"
  local slack_attempts="${15:-0}"
  local linear_status="${16:-pending}"
  local linear_attempts="${17:-0}"
  local reservation="${18:-}"
  local bs_alias="${19:-bs:abc123}"
  local last_primary="${20:-1700000600}"
  local non_primary="${21:-0}"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$id" "$ns" "$category" "$first_seen" "$last_seen" "$last_nonempty" "$version" "$fingerprint" "$keys" "$linear_ticket" "$thread_ts" "$workloads" "$drift" "$slack_status" "$slack_attempts" "$linear_status" "$linear_attempts" "$reservation" "$bs_alias" "$last_primary" "$non_primary"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

STATE_FILE_PATH="${TMP_DIR}/active-incidents.tsv"
export STATE_FILE_PATH

state_init "$STATE_FILE_PATH"
assert_true "state file exists" test -f "$STATE_FILE_PATH"
HEADER="$(head -n 1 "$STATE_FILE_PATH")"
assert_eq $'#v1\tincident_id\tnamespace\tprimary_category\tfirst_seen_ts\tlast_seen_ts\tlast_nonempty_ts\trca_version\tevidence_fingerprint\tevidence_signal_keys\tlinear_ticket_id\tslack_thread_ts\taffected_workloads\tcategory_drift_log\tslack_post_status\tslack_post_attempts\tlinear_post_status\tlinear_post_attempts\tlinear_reservation\tbs_alias\tlast_primary_ts\tnon_primary_streak' "$HEADER" "schema header written"
pass "schema header"

ROW_1="$(make_row "inc-1")"
state_write_row "inc-1" "$ROW_1" "$STATE_FILE_PATH"
READ_1="$(state_read_incident "inc-1" "$STATE_FILE_PATH")"
assert_eq "$ROW_1" "$READ_1" "write/read row"
pass "write + read incident"

if state_validate_atomic "bad value with space"; then
  fail "invalid atomic value should fail"
fi
BAD_ROW="$(make_row "inc-bad" "morpho-dev" "resource_exhaustion" "1700000000" "1700000600" "1700000600" "1" "fp" "step01:oom|bad token")"
if state_write_row "inc-bad" "$BAD_ROW" "$STATE_FILE_PATH" >/dev/null 2>&1; then
  fail "invalid row should be rejected"
fi
pass "atomic validation"

(
  i=1
  while [[ "$i" -le 25 ]]; do
    state_write_row "a-${i}" "$(make_row "a-${i}" "morpho-dev")" "$STATE_FILE_PATH"
    i=$((i + 1))
  done
) &
PID_A=$!
(
  j=1
  while [[ "$j" -le 25 ]]; do
    state_write_row "b-${j}" "$(make_row "b-${j}" "monitoring")" "$STATE_FILE_PATH"
    j=$((j + 1))
  done
) &
PID_B=$!
wait "$PID_A"
wait "$PID_B"
assert_true "concurrent rows written" state_read_incident "a-25" "$STATE_FILE_PATH"
assert_true "concurrent rows written 2" state_read_incident "b-25" "$STATE_FILE_PATH"
pass "concurrent write safety"

printf 'garbage\n' >"$STATE_FILE_PATH"
state_init "$STATE_FILE_PATH"
NEW_HEADER="$(head -n 1 "$STATE_FILE_PATH")"
assert_eq "$HEADER" "$NEW_HEADER" "corrupt file rebuilt"
assert_true "quarantine file created" bash -lc "ls '${STATE_FILE_PATH}.corrupt.'* >/dev/null 2>&1"
pass "corrupt quarantine + rebuild"

ROW_RT="$(make_row "inc-roundtrip" "monitoring" "config_drift" "1700010000" "1700010300" "1700010200" "3" "fingerprint001" "step01:argocd|step02:drift" "PLA-123" "1711111111.222200" "api|redis" "1700010200:config_drift,1700010300:resource_exhaustion" "failed_retryable" "2" "sent" "1" "pending:1700010300" "bs:888" "1700010300" "4")"
state_write_row "inc-roundtrip" "$ROW_RT" "$STATE_FILE_PATH"
ROUNDTRIP_READ="$(state_read_incident "inc-roundtrip" "$STATE_FILE_PATH")"
assert_eq "$ROW_RT" "$ROUNDTRIP_READ" "round-trip row equality"
pass "round-trip 21 columns"

ARCHIVE_FILE="${TMP_DIR}/resolved-incidents.tsv"
state_archive_row "inc-roundtrip" "stale_timeout" "$STATE_FILE_PATH" "$ARCHIVE_FILE"
if state_read_incident "inc-roundtrip" "$STATE_FILE_PATH" >/dev/null 2>&1; then
  fail "archived incident should be removed from active"
fi
ARCHIVE_HEADER="$(head -n 1 "$ARCHIVE_FILE")"
assert_eq $'#v1-resolved\tincident_id\tnamespace\tprimary_category\tfirst_seen_ts\tlast_seen_ts\tlast_nonempty_ts\trca_version\tevidence_fingerprint\tevidence_signal_keys\tlinear_ticket_id\tslack_thread_ts\taffected_workloads\tcategory_drift_log\tslack_post_status\tslack_post_attempts\tlinear_post_status\tlinear_post_attempts\tlinear_reservation\tbs_alias\tlast_primary_ts\tnon_primary_streak\tresolution_reason\tresolved_ts' "$ARCHIVE_HEADER" "archive header"
ARCHIVE_ROW="$(awk -F'\t' '$1=="inc-roundtrip" {print; exit}' "$ARCHIVE_FILE")"
[[ -n "$ARCHIVE_ROW" ]] || fail "archive row not found"
assert_eq "stale_timeout" "$(printf '%s\n' "$ARCHIVE_ROW" | awk -F'\t' '{print $22}')" "archive reason"
pass "archive row"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
