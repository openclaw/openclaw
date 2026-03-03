#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

if ! command -v jq >/dev/null 2>&1; then
  printf 'skip - jq missing\n'
  exit 0
fi

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$1"
}

INCIDENT_STATE_DIR="${TMPDIR_TEST}/state"
mkdir -p "$INCIDENT_STATE_DIR"

_rca_prompt_scrub() {
  printf '%s\n' "${1:-}" \
    | sed -E 's/(Bearer[[:space:]]+)[A-Za-z0-9._=-]+/\1<redacted>/Ig'
}

# shellcheck source=lib-overlay-suggestions.sh
source "${SCRIPT_DIR}/lib-overlay-suggestions.sh"

SUGGESTIONS_FILE="$(_overlay_suggestions_file)"

count_entries() {
  if [[ -f "$SUGGESTIONS_FILE" ]]; then
    wc -l <"$SUGGESTIONS_FILE" | tr -d '[:space:]'
  else
    printf '0\n'
  fi
}

suggestion_write '{
  "suggestion_key":"dev-morpho:production:api-gateway:oom-upload-buffering",
  "cluster":"dev-morpho",
  "namespace":"production",
  "service":"api-gateway",
  "suggestion_type":"new_failure_mode",
  "proposed_entry":{"id":"oom-upload-buffering","pattern":"OOMKilled","remediation":"scale replicas"},
  "confidence":85
}' >/dev/null

if [[ "$(count_entries)" == "1" ]]; then
  pass "initial write creates one entry"
else
  fail "initial write should create one entry"
fi

suggestion_write '{
  "suggestion_key":"dev-morpho:production:api-gateway:oom-upload-buffering",
  "cluster":"dev-morpho",
  "namespace":"production",
  "service":"api-gateway",
  "suggestion_type":"new_failure_mode",
  "proposed_entry":{"id":"oom-upload-buffering","pattern":"OOMKilled","remediation":"set memory limit"},
  "confidence":91
}' >/dev/null

if [[ "$(count_entries)" == "1" ]]; then
  pass "upsert keeps single row for same key"
else
  fail "upsert should not append duplicate row"
fi

updated_confidence="$(jq -sr '
  map(select(.suggestion_key == "dev-morpho:production:api-gateway:oom-upload-buffering"))[0].confidence
' "$SUGGESTIONS_FILE")"
if [[ "$updated_confidence" == "91" ]]; then
  pass "upsert updates existing entry"
else
  fail "upsert did not update confidence"
fi

suggestion_write '{
  "suggestion_key":"dev-morpho:production:api-gateway:latency-spike",
  "cluster":"dev-morpho",
  "namespace":"production",
  "service":"api-gateway",
  "suggestion_type":"new_failure_mode",
  "proposed_entry":{"id":"latency-spike","pattern":"p99 > 3s","remediation":"scale"},
  "confidence":70
}' >/dev/null

if [[ "$(count_entries)" == "2" ]]; then
  pass "new key appends"
else
  fail "new key should append"
fi

suggestion_write '{
  "suggestion_key":"dev-morpho:production:api-gateway:secret-test",
  "cluster":"dev-morpho",
  "namespace":"production",
  "service":"api-gateway",
  "suggestion_type":"new_failure_mode",
  "proposed_entry":{"id":"secret-test","pattern":"secret in evidence","remediation":"Bearer abcdefghijklmnopqrstuvwxyz1234567890"},
  "confidence":80
}' >/dev/null

if rg -q 'abcdefghijklmnopqrstuvwxyz1234567890' "$SUGGESTIONS_FILE"; then
  fail "redaction should scrub secrets before persistence"
else
  pass "redaction runs before persistence"
fi

suggestion_write '{
  "suggestion_key":"dev-morpho:production:api-gateway:stale-key",
  "cluster":"dev-morpho",
  "namespace":"production",
  "service":"api-gateway",
  "suggestion_type":"new_failure_mode",
  "proposed_entry":{"id":"stale-key","pattern":"stale","remediation":"none"},
  "confidence":10
}' >/dev/null

tmp_edit="${SUGGESTIONS_FILE}.edit"
jq -c '
  if .suggestion_key == "dev-morpho:production:api-gateway:stale-key" then
    .timestamp = "1970-01-01T00:00:00Z"
    | .timestamp_epoch = 0
  else
    .
  end
' "$SUGGESTIONS_FILE" >"$tmp_edit"
mv -f "$tmp_edit" "$SUGGESTIONS_FILE"

suggestion_write '{
  "suggestion_key":"dev-morpho:production:api-gateway:fresh-after-stale",
  "cluster":"dev-morpho",
  "namespace":"production",
  "service":"api-gateway",
  "suggestion_type":"new_failure_mode",
  "proposed_entry":{"id":"fresh-after-stale","pattern":"fresh","remediation":"none"},
  "confidence":55
}' >/dev/null

stale_exists="$(jq -sr 'any(.[]; .suggestion_key == "dev-morpho:production:api-gateway:stale-key")' "$SUGGESTIONS_FILE")"
if [[ "$stale_exists" == "false" ]]; then
  pass "expired rows are pruned"
else
  fail "expired row should be pruned"
fi

for i in $(seq 1 60); do
  suggestion_write "{
    \"suggestion_key\":\"dev-morpho:production:api-gateway:cap-${i}\",
    \"cluster\":\"dev-morpho\",
    \"namespace\":\"production\",
    \"service\":\"api-gateway\",
    \"suggestion_type\":\"new_failure_mode\",
    \"proposed_entry\":{\"id\":\"cap-${i}\",\"pattern\":\"p${i}\",\"remediation\":\"r${i}\"},
    \"confidence\":50
  }" >/dev/null
done

if [[ "$(count_entries)" == "50" ]]; then
  pass "cap enforces 50 entries"
else
  fail "cap should enforce 50 entries"
fi

has_newest="$(jq -sr 'any(.[]; .suggestion_key == "dev-morpho:production:api-gateway:cap-60")' "$SUGGESTIONS_FILE")"
has_oldest="$(jq -sr 'any(.[]; .suggestion_key == "dev-morpho:production:api-gateway:cap-1")' "$SUGGESTIONS_FILE")"
if [[ "$has_newest" == "true" && "$has_oldest" == "false" ]]; then
  pass "cap keeps newest entries"
else
  fail "cap ordering wrong (newest/oldest check)"
fi

suggestion_set_status "dev-morpho:production:api-gateway:cap-60" "approved" >/dev/null
pending_contains_approved="$(
  suggestion_list_pending | jq -s '
    any(.[]; .suggestion_key == "dev-morpho:production:api-gateway:cap-60")
  '
)"
if [[ "$pending_contains_approved" == "false" ]]; then
  pass "set_status removes approved row from pending list"
else
  fail "approved row should not be in pending list"
fi

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
