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

assert_json_field() {
  local label="$1"
  local json="$2"
  local field="$3"
  if printf '%s\n' "$json" | jq -e "$field" >/dev/null 2>&1; then
    pass "$label"
  else
    fail "$label"
  fi
}

test_now_ms() {
  local ms
  ms="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ms" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$ms"
    return 0
  fi
  printf '%s\n' "$(( $(date +%s) * 1000 ))"
}

INCIDENT_STATE_DIR="${TMPDIR_TEST}/default"
mkdir -p "$INCIDENT_STATE_DIR"

# shellcheck source=lib-rca-chain.sh
source "${SCRIPT_DIR}/lib-rca-chain.sh"
# shellcheck source=lib-rca-crossreview.sh
source "${SCRIPT_DIR}/lib-rca-crossreview.sh"

_chain_llm_call() {
  local stage="$1"
  case "$stage" in
    A)
      cat <<'JSON'
{"signals":[{"step":"01","classification":"signal","relevance":0.92,"summary":"3/3 pods OOMKilled"}],"noise":[],"signal_count":1}
JSON
      ;;
    B)
      cat <<'JSON'
{"hypotheses":[{"hypothesis_id":"resource_exhaustion:oom-under-load","canonical_category":"resource_exhaustion","description":"Memory leak in latest deploy","confidence":85,"supporting_evidence":["Step 01: OOMKilled"],"contradicting_evidence":[]}],"top_hypothesis_id":"resource_exhaustion:oom-under-load"}
JSON
      ;;
    C)
      cat <<'JSON'
{"causal_chain":{"trigger":"Deploy v2.4.0 at 14:02","propagation":["memory growth 380Mi→512Mi"],"symptoms":["OOMKilled on all pods"]},"gaps":[]}
JSON
      ;;
    D)
      cat <<'JSON'
{"actions":[{"type":"IMMEDIATE","action":"Scale to 4 replicas","blast_radius":"api-gateway only","rollback":"scale back to 3"}],"action_plan_quality":"specific"}
JSON
      ;;
    *)
      printf 'unexpected stage: %s\n' "$stage" >&2
      return 1
      ;;
  esac
}
export -f _chain_llm_call

RCA_CHAIN_TOTAL_TIMEOUT_MS=60000
RCA_STAGE_TIMEOUT_MS=10000
RCA_CHAIN_STAGE_E_ENABLED=0
RCA_CHAIN_CIRCUIT_BREAKER_THRESHOLD=3
RCA_CHAIN_CIRCUIT_BREAKER_COOLDOWN_S=3600
RCA_CHAIN_COST_ALERT_THRESHOLD=0

result="$(run_rca_chain "test evidence" "critical" "" "")"
mode="$(printf '%s\n' "$result" | jq -r '.mode')"
if [[ "$mode" == "chain_v2" ]]; then
  pass "critical severity returns chain_v2"
else
  fail "critical severity expected chain_v2, got ${mode}"
fi

for field in '.severity' '.canonical_category' '.summary' '.root_cause' '.hypotheses' '.rca_confidence' '.mode'; do
  assert_json_field "required field ${field}" "$result" "$field"
done

stages="$(printf '%s\n' "$result" | jq -r '.chain_metadata.stages_completed | join(",")')"
if [[ "$stages" == "A,B,C,D" ]]; then
  pass "critical severity runs A,B,C,D"
else
  fail "critical severity stages expected A,B,C,D got ${stages}"
fi

_chain_llm_call() {
  local stage="$1"
  case "$stage" in
    A)
      printf '%s\n' '{"signals":[{"step":"01","classification":"signal","relevance":0.9,"summary":"pod restarted"}],"noise":[],"signal_count":1}'
      ;;
    B)
      printf '%s\n' '{"hypotheses":[{"hypothesis_id":"resource_exhaustion:memory-pressure","canonical_category":"resource_exhaustion","description":"temporary memory pressure","confidence":40,"supporting_evidence":["Step 01"],"contradicting_evidence":[]}],"top_hypothesis_id":"resource_exhaustion:memory-pressure"}'
      ;;
    *)
      printf 'unexpected stage for low severity: %s\n' "$stage" >&2
      return 1
      ;;
  esac
}
export -f _chain_llm_call

result_low="$(run_rca_chain "test evidence" "low" "" "")"
stages_low="$(printf '%s\n' "$result_low" | jq -r '.chain_metadata.stages_completed | join(",")')"
if [[ "$stages_low" == "A,B" ]]; then
  pass "low severity runs A,B only"
else
  fail "low severity expected A,B got ${stages_low}"
fi

mode_low="$(printf '%s\n' "$result_low" | jq -r '.mode')"
if [[ "$mode_low" == "chain_v2_partial" ]]; then
  pass "low severity is partial contract"
else
  fail "low severity expected chain_v2_partial got ${mode_low}"
fi

_chain_llm_call() {
  local stage="$1"
  case "$stage" in
    A) printf '%s\n' '{"signals":[],"noise":[{"step":"01","classification":"noise"}],"signal_count":0}' ;;
    *) printf 'unexpected stage with zero signals: %s\n' "$stage" >&2; return 1 ;;
  esac
}
export -f _chain_llm_call

result_empty="$(run_rca_chain "test evidence" "high" "" "")"
mode_empty="$(printf '%s\n' "$result_empty" | jq -r '.mode')"
if [[ "$mode_empty" == "chain_v2_partial" ]]; then
  pass "zero signals returns chain_v2_partial"
else
  fail "zero signals expected chain_v2_partial got ${mode_empty}"
fi

stages_empty="$(printf '%s\n' "$result_empty" | jq -r '.chain_metadata.stages_completed | join(",")')"
if [[ "$stages_empty" == "A" ]]; then
  pass "zero signals stops after Stage A"
else
  fail "zero signals expected stages A got ${stages_empty}"
fi

_chain_llm_call() {
  printf 'unexpected call under budget exhaustion\n' >&2
  return 1
}
export -f _chain_llm_call

RCA_CHAIN_TOTAL_TIMEOUT_MS=5000
RCA_STAGE_TIMEOUT_MS=10000
result_budget="$(run_rca_chain "test evidence" "high" "" "")"
stages_budget="$(printf '%s\n' "$result_budget" | jq -r '.chain_metadata.stages_completed | join(",")')"
if [[ -z "$stages_budget" ]]; then
  pass "budget gate blocks stage start"
else
  fail "budget gate expected no stages got ${stages_budget}"
fi

RCA_CHAIN_TOTAL_TIMEOUT_MS=60000
RCA_STAGE_TIMEOUT_MS=10000
INCIDENT_STATE_DIR="${TMPDIR_TEST}/circuit"
mkdir -p "$INCIDENT_STATE_DIR"
RCA_CHAIN_CIRCUIT_BREAKER_THRESHOLD=3
RCA_CHAIN_CIRCUIT_BREAKER_COOLDOWN_S=3600

_chain_llm_call() { return 1; }
export -f _chain_llm_call

for _ in 1 2 3; do
  run_rca_chain "evidence" "high" "" "" >/dev/null 2>&1 || true
done

if _chain_circuit_breaker_open; then
  pass "circuit breaker opens after 3 failures"
else
  fail "circuit breaker expected open"
fi

breaker_file="$(_chain_circuit_breaker_file)"
printf '3\t%s\n' "$(( $(date +%s) - 7200 ))" >"$breaker_file"
if _chain_circuit_breaker_open; then
  fail "circuit breaker expected auto-recover after cooldown"
else
  pass "circuit breaker auto-recovers after cooldown"
fi

INCIDENT_STATE_DIR="${TMPDIR_TEST}/stage-e"
mkdir -p "$INCIDENT_STATE_DIR"
RCA_CHAIN_TOTAL_TIMEOUT_MS=60000
RCA_STAGE_TIMEOUT_MS=10000
RCA_CHAIN_STAGE_E_ENABLED=1

_chain_llm_call() {
  local stage="$1"
  case "$stage" in
    A) printf '%s\n' '{"signals":[{"step":"01","classification":"signal","relevance":0.9,"summary":"OOM"}],"noise":[],"signal_count":1}' ;;
    B) printf '%s\n' '{"hypotheses":[{"hypothesis_id":"resource_exhaustion:oom","canonical_category":"resource_exhaustion","description":"OOM under load","confidence":88,"supporting_evidence":["01"],"contradicting_evidence":[]}],"top_hypothesis_id":"resource_exhaustion:oom"}' ;;
    C) printf '%s\n' '{"causal_chain":{"trigger":"deploy","propagation":["memory"],"symptoms":["OOM"]},"gaps":[]}' ;;
    D) printf '%s\n' '{"actions":[{"type":"IMMEDIATE","action":"scale replicas"}],"action_plan_quality":"specific"}' ;;
    E) printf '%s\n' '{"validated":true,"revision_notes":null,"review_pass":"accepted"}' ;;
    *) return 1 ;;
  esac
}
export -f _chain_llm_call

result_e="$(run_rca_chain "evidence" "critical" "" "")"
stages_e="$(printf '%s\n' "$result_e" | jq -r '.chain_metadata.stages_completed | join(",")')"
if [[ "$stages_e" == "A,B,C,D,E" ]]; then
  pass "critical severity runs Stage E when enabled"
else
  fail "stage E expected A,B,C,D,E got ${stages_e}"
fi

mode_e="$(printf '%s\n' "$result_e" | jq -r '.mode')"
if [[ "$mode_e" == "chain_v2" ]]; then
  pass "stage E path returns chain_v2"
else
  fail "stage E path expected chain_v2 got ${mode_e}"
fi

INCIDENT_STATE_DIR="${TMPDIR_TEST}/dual"
mkdir -p "$INCIDENT_STATE_DIR"
RCA_CHAIN_STAGE_E_ENABLED=0
RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS=4
DUAL_TRACE_FILE="${TMPDIR_TEST}/dual-trace.tsv"
: >"$DUAL_TRACE_FILE"

_chain_llm_call() {
  local stage="$1"
  local provider="${_CHAIN_ACTIVE_PROVIDER:-codex}"
  local now
  case "$stage" in
    A)
      now="$(test_now_ms)"
      printf '%s\tstart\t%s\n' "$provider" "$now" >>"$DUAL_TRACE_FILE"
      sleep 0.2
      now="$(test_now_ms)"
      printf '%s\tend\t%s\n' "$provider" "$now" >>"$DUAL_TRACE_FILE"
      printf '%s\n' '{"signals":[{"step":"01","classification":"signal","relevance":0.9,"summary":"oom"}],"noise":[],"signal_count":1}'
      ;;
    B)
      if [[ "$provider" == "claude" ]]; then
        printf '%s\n' '{"hypotheses":[{"hypothesis_id":"resource_exhaustion:claude-initial","canonical_category":"resource_exhaustion","description":"claude initial","confidence":74,"supporting_evidence":["01"],"contradicting_evidence":[],"evidence_keys":["e1","e2","e3"]}],"top_hypothesis_id":"resource_exhaustion:claude-initial"}'
      else
        printf '%s\n' '{"hypotheses":[{"hypothesis_id":"resource_exhaustion:codex-initial","canonical_category":"resource_exhaustion","description":"codex initial","confidence":79,"supporting_evidence":["01"],"contradicting_evidence":[],"evidence_keys":["e1","e2","e3"]}],"top_hypothesis_id":"resource_exhaustion:codex-initial"}'
      fi
      ;;
    C)
      printf '%s\n' '{"causal_chain":{"trigger":"deploy","propagation":["memory growth"],"symptoms":["oom"]},"gaps":[]}'
      ;;
    D)
      printf '%s\n' '{"actions":[{"type":"IMMEDIATE","action":"restart pods"}],"action_plan_quality":"specific"}'
      ;;
    R)
      printf '%s\n' '{"severity":"high","canonical_category":"resource_exhaustion","summary":"aligned","root_cause":"deploy","agree_with_peer":true,"hypotheses":[{"hypothesis_id":"resource_exhaustion:oom-under-load","canonical_category":"resource_exhaustion","description":"aligned hypothesis","confidence":90,"evidence_keys":["e1","e2","e3"]}]}'
      ;;
    *)
      return 1
      ;;
  esac
}
export -f _chain_llm_call

result_dual="$(run_rca_chain "evidence" "critical" "" "" "dual")"
dual_rounds="$(printf '%s\n' "$result_dual" | jq -r '.review_rounds // -1')"
if [[ "$dual_rounds" == "1" ]]; then
  pass "dual chain converges after one review round"
else
  fail "dual chain expected review_rounds=1 got ${dual_rounds}"
fi

dual_enabled="$(printf '%s\n' "$result_dual" | jq -r '.chain_metadata.dual_review.enabled // false')"
if [[ "$dual_enabled" == "true" ]]; then
  pass "dual review metadata enabled"
else
  fail "dual review metadata should be enabled"
fi

codex_start="$(awk -F'\t' '$1=="codex" && $2=="start"{print $3; exit}' "$DUAL_TRACE_FILE")"
codex_end="$(awk -F'\t' '$1=="codex" && $2=="end"{print $3; exit}' "$DUAL_TRACE_FILE")"
claude_start="$(awk -F'\t' '$1=="claude" && $2=="start"{print $3; exit}' "$DUAL_TRACE_FILE")"
claude_end="$(awk -F'\t' '$1=="claude" && $2=="end"{print $3; exit}' "$DUAL_TRACE_FILE")"
if [[ -n "$codex_start" && -n "$codex_end" && -n "$claude_start" && -n "$claude_end" ]] \
  && (( claude_start <= codex_end )) \
  && (( codex_start <= claude_end )); then
  pass "dual chain provider runs overlap in time"
else
  fail "dual chain provider runs did not overlap"
fi

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
