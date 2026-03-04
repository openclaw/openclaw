#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL: %s\n' "$1" >&2
}

if ! command -v jq >/dev/null 2>&1; then
  printf 'skip: jq missing\n'
  exit 0
fi

INCIDENT_STATE_DIR="$TMP_DIR"
INCIDENT_MEMORY_FILE="$TMP_DIR/incident-memory.jsonl"
INCIDENT_MEMORY_LOCK="$TMP_DIR/incident-memory.lock"
INCIDENT_MEMORY_MAX_ENTRIES=500
export INCIDENT_STATE_DIR INCIDENT_MEMORY_FILE INCIDENT_MEMORY_LOCK INCIDENT_MEMORY_MAX_ENTRIES

_rca_prompt_scrub() {
  printf '%s\n' "$1"
}

# shellcheck source=lib-incident-memory.sh
source "${SCRIPT_DIR}/lib-incident-memory.sh"

CARD_1='{"card_id":"hb:production:resource_exhaustion:20260215T1402:a3f8b2c1","triage_incident_id":"hb:production:resource_exhaustion:fp:d4e5f6a7:abc123","card_type":"full","namespace":"production","cluster":"dev-morpho","service":"api-gateway","date":"2026-02-15","category":"resource_exhaustion","severity":"high","root_cause_summary":"memory leak in v2.3.1","rca_confidence":85,"evidence_fingerprint":"d4e5f6a7"}'
memory_write_card "$CARD_1"

if [[ -s "$INCIDENT_MEMORY_FILE" ]]; then
  pass 'incident memory file created'
else
  fail 'incident memory file missing'
fi

MATCH_BROAD="$(memory_lookup_broad "dev-morpho" "production" "api-gateway")"
if printf '%s\n' "$MATCH_BROAD" | jq -e '.[0].card_id == "hb:production:resource_exhaustion:20260215T1402:a3f8b2c1"' >/dev/null 2>&1; then
  pass 'broad lookup returns matching card'
else
  fail 'broad lookup missing expected card'
fi

MATCH_PRECISE="$(memory_lookup_precise "dev-morpho" "production" "api-gateway" "resource_exhaustion")"
if printf '%s\n' "$MATCH_PRECISE" | jq -e 'length == 1 and .[0].category == "resource_exhaustion"' >/dev/null 2>&1; then
  pass 'precise lookup category filter works'
else
  fail 'precise lookup result incorrect'
fi

MATCH_NONE="$(memory_lookup_broad "dev-morpho" "staging" "nonexistent")"
if printf '%s\n' "$MATCH_NONE" | jq -e 'length == 0' >/dev/null 2>&1; then
  pass 'missing service returns empty array'
else
  fail 'missing service should return empty array'
fi

for i in 2 3; do
  CARD_N='{"card_id":"hb:production:bad_deploy:2026021'"$i"'T1402:b4c5d6e7","triage_incident_id":"triage'"$i"'","card_type":"partial","namespace":"production","cluster":"dev-morpho","service":"api-gateway","date":"2026-02-1'"$i"'","category":"bad_deploy","severity":"medium","rca_confidence":60,"evidence_fingerprint":"b4c5d6e'"$i"'"}'
  memory_write_card "$CARD_N"
done

TOTAL_LINES="$(wc -l < "$INCIDENT_MEMORY_FILE")"
if [[ "$TOTAL_LINES" -eq 3 ]]; then
  pass 'three cards stored'
else
  fail "expected 3 stored cards, got ${TOTAL_LINES}"
fi

FORMAT_OUT="$(memory_lookup_broad "dev-morpho" "production" "api-gateway" | format_memory_context)"
if [[ "$FORMAT_OUT" == *"Past incidents (last 90d):"* ]] && [[ "$FORMAT_OUT" == *"resource_exhaustion"* ]]; then
  pass 'memory context formatter output generated'
else
  fail 'memory context formatter missing expected content'
fi

CHAIN_OUTPUT='{"severity":"high","canonical_category":"resource_exhaustion","summary":"OOM from memory leak","root_cause":"deploy v2.4.0","hypotheses":[{"hypothesis_id":"resource_exhaustion:oom","confidence":85}],"rca_confidence":85,"mode":"chain_v2","chain_metadata":{"stages_completed":["A","B","C","D"]}}'
CARD_EXTRACTED="$(
  CLUSTER="dev-morpho" \
  NAMESPACE="production" \
  SERVICE="api-gateway" \
  TRIAGE_INCIDENT_ID="hb:production:resource_exhaustion:fp:abc:def" \
  extract_incident_card "$CHAIN_OUTPUT"
)"

if printf '%s\n' "$CARD_EXTRACTED" | jq -e '.card_type == "full" and .category == "resource_exhaustion" and .triage_incident_id == "hb:production:resource_exhaustion:fp:abc:def"' >/dev/null 2>&1; then
  pass 'extract_incident_card returns full card for A-D chain output'
else
  fail 'extract_incident_card full-card extraction failed'
fi

LEGACY_OUTPUT='{"severity":"low","canonical_category":"config_drift","summary":"drift","root_cause":"manual change","hypotheses":[{"hypothesis_id":"config_drift:argocd_out_of_sync","confidence":61}],"rca_confidence":61}'
LEGACY_CARD="$(
  CLUSTER="dev-morpho" \
  NAMESPACE="production" \
  SERVICE="api-gateway" \
  TRIAGE_INCIDENT_ID="hb:production:config_drift:fp:1234:xyz" \
  extract_incident_card "$LEGACY_OUTPUT"
)"
if printf '%s\n' "$LEGACY_CARD" | jq -e '.card_type == "partial" and .evidence_fingerprint == "1234"' >/dev/null 2>&1; then
  pass 'extract_incident_card returns partial card for legacy output'
else
  fail 'extract_incident_card partial-card extraction failed'
fi

printf '\nResults: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
