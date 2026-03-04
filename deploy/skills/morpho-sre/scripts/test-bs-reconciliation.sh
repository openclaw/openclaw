#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-state-file.sh
source "${SCRIPT_DIR}/lib-state-file.sh"
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

make_row() {
  local id="$1"
  local bs_alias="$2"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$id" "morpho-dev" "resource_exhaustion" "1700000000" "1700000600" "1700000600" "1" "fp123abc" \
    "pod_issue|log_signal" "" "" "api|worker" "" "pending" "0" "pending" "0" "" "$bs_alias" "1700000600" "0"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ACTIVE_FILE="${TMP_DIR}/active-incidents.tsv"
export STATE_FILE_PATH="$ACTIVE_FILE"
state_init "$ACTIVE_FILE"

EXISTING_INCIDENT_ID="hb:morpho-dev:resource_exhaustion:fp123abc:deadbeef"
BS_ALIAS="$(generate_incident_id betterstack "INC-42" "" "" 2>/dev/null || true)"
ROW="$(make_row "$EXISTING_INCIDENT_ID" "$BS_ALIAS")"
state_write_row "$EXISTING_INCIDENT_ID" "$ROW" "$ACTIVE_FILE"

MATCHED_ID="$(state_read_all "$ACTIVE_FILE" | awk -F'\t' -v alias="$BS_ALIAS" 'NF >= 19 && $19 == alias { print $1; exit }')"
assert_eq "$EXISTING_INCIDENT_ID" "$MATCHED_ID" "find existing heartbeat incident by bs alias"
pass "alias lookup returns existing incident id"

NEW_ALIAS="$(generate_incident_id betterstack "INC-99" "" "" 2>/dev/null || true)"
UPDATED_ROW="$(make_row "$EXISTING_INCIDENT_ID" "$NEW_ALIAS")"
state_write_row "$EXISTING_INCIDENT_ID" "$UPDATED_ROW" "$ACTIVE_FILE"
READ_BACK="$(state_read_incident "$EXISTING_INCIDENT_ID" "$ACTIVE_FILE")"
READ_ALIAS="$(printf '%s\n' "$READ_BACK" | awk -F'\t' '{print $19}')"
assert_eq "$NEW_ALIAS" "$READ_ALIAS" "bs alias update persisted"
pass "alias update persisted"

printf 'all tests passed (%d)\n' "$PASS_COUNT"

