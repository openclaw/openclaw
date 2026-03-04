#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-rca-crossreview.sh
source "${SCRIPT_DIR}/lib-rca-crossreview.sh"

if ! command -v jq >/dev/null 2>&1; then
  printf 'skip - jq missing\n'
  exit 0
fi

PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

RCA_A='{"canonical_category":"resource_exhaustion","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:redis_pool","confidence":90,"description":"redis connection pool exhausted due to burst","evidence_keys":["e1","e2","e3"]}]}'
RCA_B='{"canonical_category":"resource_exhaustion","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:redis_pool","confidence":80,"description":"redis pool exhausted after traffic burst","evidence_keys":["e1","e2","e3","e4"]}]}'

check_convergence "$RCA_A" "$RCA_B" 0 >/dev/null || fail "round0 convergence should pass"
pass "round0 convergence"

RCA_A_R1='{"canonical_category":"resource_exhaustion","agree_with_peer":true,"hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:redis_pool","confidence":90,"description":"redis connection pool exhausted due to burst","evidence_keys":["e1","e2","e3"]}]}'
RCA_B_R1='{"canonical_category":"resource_exhaustion","agree_with_peer":true,"hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:redis_pool","confidence":85,"description":"redis pool exhausted after traffic burst","evidence_keys":["e1","e2","e3","e4"]}]}'
check_convergence "$RCA_A_R1" "$RCA_B_R1" 1 >/dev/null || fail "round1 convergence should require agree_with_peer true"
pass "round1 convergence"

check_convergence "$RCA_A_R1" "$RCA_B_R1" 2 >/dev/null || fail "round2 convergence"
pass "round2 convergence"

RCA_WEAK='{"canonical_category":"resource_exhaustion","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:oom_memory_limit","confidence":85,"description":"oom", "evidence_keys":["e1","e2","e3"]}]}'
if check_convergence "$RCA_A" "$RCA_WEAK" 0 >/dev/null 2>&1; then
  fail "weak convergence should fail"
fi
pass "weak convergence rejection"

RCA_OTHER_A='{"canonical_category":"resource_exhaustion","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:other","confidence":70,"description":"redis timeout pool exhaustion pressure","evidence_keys":["e1","e2","e3"]}]}'
RCA_OTHER_B_BAD='{"canonical_category":"resource_exhaustion","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:other","confidence":72,"description":"database schema migration lock issue unrelated","evidence_keys":["e1","e2","e3"]}]}'
if check_convergence "$RCA_OTHER_A" "$RCA_OTHER_B_BAD" 0 >/dev/null 2>&1; then
  fail ":other low description overlap should fail"
fi
RCA_OTHER_B_OK='{"canonical_category":"resource_exhaustion","hypotheses":[{"canonical_category":"resource_exhaustion","hypothesis_id":"resource_exhaustion:other","confidence":72,"description":"redis timeout exhaustion pressure in pool","evidence_keys":["e1","e2","e3"]}]}'
check_convergence "$RCA_OTHER_A" "$RCA_OTHER_B_OK" 0 >/dev/null || fail ":other high description overlap should pass"
pass ":other special case"

MERGED="$(run_cross_review 0 "$RCA_A" "$RCA_B" "evidence")"
MERGED_NOTE="$(printf '%s\n' "$MERGED" | jq -r '.degradation_note')"
[[ "$MERGED_NOTE" == "null" ]] || fail "merged convergence should have null degradation note"
pass "both ok degradation mode"

NON_CONV="$(run_cross_review 2 "$RCA_A" "$RCA_WEAK" "evidence")"
NOTE_NON_CONV="$(printf '%s\n' "$NON_CONV" | jq -r '.degradation_note')"
[[ "$NOTE_NON_CONV" == *"did not converge"* ]] || fail "non-convergence fallback note"
pass "round2 non-convergence fallback"

NON_CONV_EXT="$(run_cross_review 2 "$RCA_A" "$RCA_WEAK" "evidence" 4)"
printf '%s\n' "$NON_CONV_EXT" | jq -e '.converged == false and .next_a != null and .next_b != null' >/dev/null \
  || fail "round2 with max_rounds=4 should continue"
pass "configurable max rounds continues review"

NON_CONV_EXT_FALLBACK="$(run_cross_review 4 "$RCA_A" "$RCA_WEAK" "evidence" 4)"
NOTE_NON_CONV_EXT="$(printf '%s\n' "$NON_CONV_EXT_FALLBACK" | jq -r '.degradation_note')"
[[ "$NOTE_NON_CONV_EXT" == *"after 4 review rounds"* ]] || fail "max_rounds fallback note should mention configured rounds"
pass "configurable max rounds fallback note"

CLAUDE_ONLY="$(run_cross_review 0 "" "$RCA_B" "evidence")"
NOTE_CLAUDE_ONLY="$(printf '%s\n' "$CLAUDE_ONLY" | jq -r '.degradation_note')"
[[ "$NOTE_CLAUDE_ONLY" == *"Codex unavailable"* ]] || fail "claude-only degradation note"
pass "claude-only mode"

CODEX_ONLY="$(run_cross_review 0 "$RCA_A" "" "evidence")"
NOTE_CODEX_ONLY="$(printf '%s\n' "$CODEX_ONLY" | jq -r '.degradation_note')"
[[ "$NOTE_CODEX_ONLY" == *"Claude unavailable"* ]] || fail "codex-only degradation note"
pass "codex-only mode"

NEITHER="$(run_cross_review 0 "" "" "evidence")"
NOTE_NEITHER="$(printf '%s\n' "$NEITHER" | jq -r '.degradation_note')"
[[ "$NOTE_NEITHER" == *"Both LLM providers unavailable"* ]] || fail "neither-available degradation note"
pass "neither-available mode"

printf 'all tests passed (%d)\n' "$PASS_COUNT"
