#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-linear-ticket.sh
source "${SCRIPT_DIR}/lib-linear-ticket.sh"

PASS_COUNT=0
MOCK_SEARCH_RESULT=""
MOCK_PATTERN_RESULTS=""
MOCK_TICKET_DESC=""
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CREATED_COUNT_FILE="${TMP_DIR}/created.count"
UPDATED_COUNT_FILE="${TMP_DIR}/updated.count"
LAST_CREATED_TITLE_FILE="${TMP_DIR}/created.title"
LAST_CREATED_DESC_FILE="${TMP_DIR}/created.desc"
LAST_CREATED_LABELS_FILE="${TMP_DIR}/created.labels"
LAST_UPDATED_DESC_FILE="${TMP_DIR}/updated.desc"
printf '0\n' >"$CREATED_COUNT_FILE"
printf '0\n' >"$UPDATED_COUNT_FILE"

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$msg"
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  [[ "$expected" == "$actual" ]] || fail "$msg (expected: $expected; got: $actual)"
}

linear_ticket_api_create() {
  local current
  current="$(cat "$CREATED_COUNT_FILE")"
  current=$((current + 1))
  printf '%s\n' "$current" >"$CREATED_COUNT_FILE"
  printf '%s\n' "$1" >"$LAST_CREATED_TITLE_FILE"
  printf '%s\n' "$2" >"$LAST_CREATED_DESC_FILE"
  printf '%s\n' "$3" >"$LAST_CREATED_LABELS_FILE"
  printf 'PLA-%03d\n' "$current"
}

linear_ticket_api_update() {
  local current
  current="$(cat "$UPDATED_COUNT_FILE")"
  current=$((current + 1))
  printf '%s\n' "$current" >"$UPDATED_COUNT_FILE"
  printf '%s\n' "$2" >"$LAST_UPDATED_DESC_FILE"
}

linear_ticket_api_get_description() {
  printf '%s\n' "$MOCK_TICKET_DESC"
}

linear_ticket_api_search_by_incident() {
  [[ -n "$MOCK_SEARCH_RESULT" ]] || return 1
  printf '%s\n' "$MOCK_SEARCH_RESULT"
}

linear_ticket_api_search_patterns() {
  printf '%s\n' "$MOCK_PATTERN_RESULTS"
}

make_row() {
  local id="$1"
  local ticket_id="${2:-}"
  local reservation="${3:-}"
  local version="${4:-1}"
  printf '%s\tmorpho-dev\tresource_exhaustion\t1700000000\t1700000600\t1700000600\t%s\tfp\tstep01:oom\t%s\t\tapi|worker\t\tpending\t0\tpending\t0\t%s\t\t1700000600\t0\n' \
    "$id" "$version" "$ticket_id" "$reservation"
}

RCA_JSON='{"severity":"medium","summary":"Redis saturation","blast_radius":"api degraded","root_cause":"pool exhausted","supporting_evidence":["oom","timeout"],"remediation":"raise pool"}'

ROW_NEW="$(make_row "inc-1")"
TICKET_ID="$(create_or_update_ticket "inc-1" "$RCA_JSON" "$ROW_NEW" 1700001000)"
assert_eq "PLA-001" "$TICKET_ID" "create ticket id"
assert_contains "$(cat "$LAST_CREATED_DESC_FILE")" "## Summary" "template summary section"
assert_contains "$(cat "$LAST_CREATED_DESC_FILE")" "## Root Cause Analysis" "template root cause section"
pass "create ticket with template"

LOW_JSON='{"severity":"low"}'
SKIP_OUT="$(create_or_update_ticket "inc-low" "$LOW_JSON" "$ROW_NEW" 1700001000)"
assert_eq $'skipped\tseverity' "$SKIP_OUT" "severity gate"
pass "severity gate"

ROW_EXISTING="$(make_row "inc-2" "PLA-777" "" 2)"
printf '0\n' >"$UPDATED_COUNT_FILE"
EXISTING_OUT="$(create_or_update_ticket "inc-2" "$RCA_JSON" "$ROW_EXISTING" 1700001000)"
assert_eq "PLA-777" "$EXISTING_OUT" "existing ticket id reused"
assert_eq "1" "$(cat "$UPDATED_COUNT_FILE")" "existing ticket updated"
pass "idempotent update path"

ROW_RESERVED="$(make_row "inc-3" "" "pending:1700000950" 1)"
RESERVED_OUT="$(create_or_update_ticket "inc-3" "$RCA_JSON" "$ROW_RESERVED" 1700001000)"
assert_eq "reserved" "$RESERVED_OUT" "fresh reservation skip"
pass "fresh reservation"

ROW_STALE="$(make_row "inc-4" "" "pending:1699990000" 1)"
STALE_OUT="$(create_or_update_ticket "inc-4" "$RCA_JSON" "$ROW_STALE" 1700001000)"
assert_eq "PLA-002" "$STALE_OUT" "stale reservation reclaimed"
pass "stale reservation reclaim"

MOCK_PATTERN_RESULTS=$'PLA-010\nPLA-011\nPLA-012'
PATTERN_OUT="$(create_or_update_ticket "inc-5" "$RCA_JSON" "$ROW_NEW" 1700001000)"
assert_eq "PLA-003" "$PATTERN_OUT" "pattern create"
assert_contains "$(cat "$LAST_CREATED_DESC_FILE")" "## Recurring Pattern" "pattern section appended"
assert_contains "$(cat "$LAST_CREATED_LABELS_FILE")" "Technical debt" "tech debt label appended"
pass "pattern detection section"
MOCK_PATTERN_RESULTS=""

NEEDS_REVIEW_DESC="$(build_ticket_description '{}' 'incident_id=inc-6;namespace=morpho-dev;category=unknown;services=')"
assert_contains "$NEEDS_REVIEW_DESC" "[NEEDS REVIEW]" "needs review marker"
pass "needs review marker"

MOCK_TICKET_DESC=$'Context\n\n### RCA v1\nold1\n\n### RCA v2\nold2\n\n### RCA v3\nold3\n'
update_ticket_rca "PLA-900" '{"foo":"bar"}' 4 >/dev/null
RCA_HEADINGS="$(grep -c '^### RCA v' "$LAST_UPDATED_DESC_FILE" || true)"
if [[ "$RCA_HEADINGS" -gt 3 ]]; then
  fail "RCA retention should cap at 3"
fi
pass "rca retention cap"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
