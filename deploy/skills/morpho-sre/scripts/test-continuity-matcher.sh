#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-continuity-matcher.sh
source "${SCRIPT_DIR}/lib-continuity-matcher.sh"

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

make_incident_row() {
  local id="$1"
  local ns="$2"
  local cat="$3"
  local first_seen="$4"
  local last_seen="$5"
  local signals="$6"
  local workloads="$7"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t1\tfp\t%s\t\t\t%s\t\tpending\t0\tpending\t0\t\t\t%s\t0\n' \
    "$id" "$ns" "$cat" "$first_seen" "$last_seen" "$last_seen" "$signals" "$workloads" "$last_seen"
}

NOW=1700003600

assert_eq "0.333" "$(jaccard "a|b" "b|c")" "jaccard baseline"
pass "jaccard"

exact_match morpho-dev resource_exhaustion "api|worker" morpho-dev resource_exhaustion "api|db" 1700000000 "$NOW" || fail "exact match should pass"
pass "exact match positive"

if exact_match morpho-dev resource_exhaustion "api" morpho-dev resource_exhaustion "api" 1699990000 "$NOW"; then
  fail "exact staleness >120m should fail"
fi
pass "exact staleness bound"

exact_match morpho-dev resource_exhaustion "" morpho-dev resource_exhaustion "api" 1700000000 "$NOW" || fail "exact empty-side skip"
pass "exact empty-side skip"

continuity_match morpho-dev config_drift "api|worker" "s1|s2|s3" morpho-dev resource_exhaustion "api|worker" "s1|s2|s9" 1700003200 "$NOW" || fail "continuity both dimensions"
pass "continuity both dimensions"

if continuity_match morpho-dev config_drift "" "s1|s2" morpho-dev resource_exhaustion "" "s3|s4" 1700003200 "$NOW"; then
  fail "continuity should fail when both telemetry dimensions empty"
fi
pass "continuity disabled both empty"

continuity_match morpho-dev config_drift "" "s1|s2|s3" morpho-dev resource_exhaustion "" "s2|s3|s4" 1700003200 "$NOW" || fail "continuity empty workloads + raised signal threshold"
pass "continuity empty workloads"

if continuity_match morpho-dev config_drift "api|worker" "" morpho-dev resource_exhaustion "worker|db" "" 1700003200 "$NOW"; then
  fail "continuity with empty signals should require high workload overlap"
fi
pass "continuity empty signals threshold"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

printf '#v1\tincident_id\tnamespace\tprimary_category\tfirst_seen_ts\tlast_seen_ts\tlast_nonempty_ts\trca_version\tevidence_fingerprint\tevidence_signal_keys\tlinear_ticket_id\tslack_thread_ts\taffected_workloads\tcategory_drift_log\tslack_post_status\tslack_post_attempts\tlinear_post_status\tlinear_post_attempts\tlinear_reservation\tbs_alias\tlast_primary_ts\tnon_primary_streak\n' >"$TMP_FILE"
make_incident_row "inc-a" morpho-dev resource_exhaustion 1700000000 1700003400 "s1|s2" "api|worker" >>"$TMP_FILE"
make_incident_row "inc-b" morpho-dev resource_exhaustion 1700000001 1700003500 "s1|s2" "api|db" >>"$TMP_FILE"
make_incident_row "inc-c" morpho-dev config_drift 1700000002 1700003500 "s1|s4|s5" "worker|db" >>"$TMP_FILE"

ROUTE_EXACT_MULTI="$(route_heartbeat morpho-dev resource_exhaustion "api|worker" "s1|s2" "$NOW" "$TMP_FILE")"
assert_eq $'match\texact_multi\tinc-a\t1.000' "$ROUTE_EXACT_MULTI" "route exact multi picks highest jaccard"
pass "route exact multi"

printf '%s\n' "$(make_incident_row "hb:morpho-dev:resource_exhaustion:20260302T1430:empty000" morpho-dev resource_exhaustion 1700000003 1700003590 "s1|s2" "")" >>"$TMP_FILE"
ROUTE_EMPTY_MULTI="$(route_heartbeat morpho-dev resource_exhaustion "" "s1|s2" "$NOW" "$TMP_FILE")"
assert_eq $'match\texact_empty_sentinel\thb:morpho-dev:resource_exhaustion:20260302T1430:empty000\t1.000' "$ROUTE_EMPTY_MULTI" "route empty workload sentinel"
pass "route empty sentinel"

ROUTE_CONT="$(route_heartbeat morpho-dev network_connectivity "worker|db" "s1|s4|s5" "$NOW" "$TMP_FILE")"
[[ "$ROUTE_CONT" == match$'\t'continuity$'\t'inc-c$'\t'* ]] || fail "continuity route expected inc-c"
pass "route continuity"

ROUTE_NEW="$(route_heartbeat morpho-dev bad_deploy "newsvc" "x1" "$NOW" "$TMP_FILE")"
assert_eq $'new\tno_match\tNEW\t0.000' "$ROUTE_NEW" "route no match"
pass "route new incident"

assert_eq "healthy_heartbeat" "$(check_stale_resolve 1700003500 1700003500 "$NOW" 0 "" "" healthy)" "resolution branch healthy"
pass "resolution branch a"

assert_eq "stale_timeout_non_primary" "$(check_stale_resolve 1700003500 1700003500 "$NOW" 3 "api" "worker" incident)" "resolution branch non-primary"
pass "resolution branch b"

assert_eq "stale_timeout_forced" "$(check_stale_resolve 1699980000 1699980000 "$NOW")" "forced stale timeout"
pass "forced stale timeout"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
