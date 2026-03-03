#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-rca-prompt.sh
source "${SCRIPT_DIR}/lib-rca-prompt.sh"

PASS_COUNT=0

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

if ! command -v jq >/dev/null 2>&1; then
  printf 'skip - jq missing\n'
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
RCA_HYPOTHESIS_VOCAB_FILE="${TMP_DIR}/vocab.json"
export RCA_HYPOTHESIS_VOCAB_FILE
cat >"$RCA_HYPOTHESIS_VOCAB_FILE" <<'VOCAB'
{
  "resource_exhaustion": ["oom_memory_limit", "redis_pool", "other"],
  "config_drift": ["argocd_out_of_sync", "other"],
  "unknown": ["insufficient_evidence"]
}
VOCAB

PROMPT="$(build_rca_prompt 'authorization: bearer abc123' 'prior incident xoxb-foo' 'skill notes')"
assert_contains "$PROMPT" "Evidence Bundle:" "prompt evidence section"
assert_contains "$PROMPT" "Controlled Vocabulary" "prompt vocabulary section"
assert_contains "$PROMPT" "\"hypothesis_id\"" "prompt schema section"
assert_contains "$PROMPT" "<redacted>" "prompt scrub redaction"
pass "prompt structure + scrub"

OUT1="$(validate_rca_output '{"canonical_category":"resource_exhaustion","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:not_in_vocab","confidence":70,"description":"x"}]}')"
ID1="$(printf '%s\n' "$OUT1" | jq -r '.hypotheses[0].hypothesis_id')"
NOTE1="$(printf '%s\n' "$OUT1" | jq -r '.hypotheses[0].variant_note')"
[[ "$ID1" == "resource_exhaustion:other" ]] || fail "invalid variant should map to :other"
[[ "$NOTE1" == "not_in_vocab" ]] || fail "variant note preserved"
pass "hypothesis id mapping"

OUT2="$(validate_rca_output '{"canonical_category":"totally_new","hypotheses":[{"canonical_category":"totally_new","hypothesis_id":"totally_new:anything"}]}')"
ID2="$(printf '%s\n' "$OUT2" | jq -r '.hypotheses[0].hypothesis_id')"
[[ "$ID2" == "unknown:insufficient_evidence" ]] || fail "unknown category should map to unknown"
pass "unknown category mapping"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
