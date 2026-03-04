#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-incident-id.sh
source "${SCRIPT_DIR}/lib-incident-id.sh"

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

BS_ID="$(generate_incident_id bs "123456")"
assert_eq "bs:123456" "$BS_ID" "betterstack id format"
pass "betterstack id"

BS_THREAD_ID="$(generate_incident_id betterstack "" "1711111111.000100")"
assert_eq "bs:thread:1711111111.000100" "$BS_THREAD_ID" "betterstack thread fallback"
pass "betterstack thread fallback"

HB_ID="$(generate_incident_id heartbeat morpho-dev resource_exhaustion 20260302T1430 "api|worker")"
[[ "$HB_ID" =~ ^hb:morpho-dev:resource_exhaustion:20260302T1430:[a-f0-9]{8}$ ]] || fail "heartbeat id format"
pass "heartbeat id format"

EMPTY_HASH="$(compute_workload_hash8 "")"
assert_eq "empty000" "$EMPTY_HASH" "empty workload sentinel"
pass "empty workload sentinel"

ID_A="$(generate_incident_id hb morpho-dev resource_exhaustion 20260302T1430 "api")"
ID_B="$(generate_incident_id hb morpho-dev resource_exhaustion 20260302T1430 "worker")"
[[ "$ID_A" != "$ID_B" ]] || fail "different workloads should produce different ids"
pass "same-minute different workloads => different id"

ID_C="$(generate_incident_id hb morpho-dev resource_exhaustion 20260302T1430 "worker|api")"
ID_D="$(generate_incident_id hb morpho-dev resource_exhaustion 20260302T1430 "api|worker")"
assert_eq "$ID_C" "$ID_D" "same workloads should produce same id"
pass "same-minute same workloads => same id"

ID_UNKNOWN="$(generate_incident_id hb morpho-dev "" 20260302T1430 "api")"
[[ "$ID_UNKNOWN" == hb:morpho-dev:unknown:* ]] || fail "unknown category fallback"
pass "unknown category fallback"

PARSED_ID="$(extract_betterstack_id "alert from https://betterstack.com/incidents/INC-777 details")"
assert_eq "INC-777" "$PARSED_ID" "extract betterstack id from url"
pass "extract betterstack id"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
