#!/usr/bin/env bash

RCA_CHAIN_ENABLED="${RCA_CHAIN_ENABLED:-0}"
RCA_CHAIN_STAGE_E_ENABLED="${RCA_CHAIN_STAGE_E_ENABLED:-0}"
RCA_CHAIN_TOTAL_TIMEOUT_MS="${RCA_CHAIN_TOTAL_TIMEOUT_MS:-60000}"
RCA_STAGE_TIMEOUT_MS="${RCA_STAGE_TIMEOUT_MS:-10000}"
RCA_CHAIN_COST_ALERT_THRESHOLD="${RCA_CHAIN_COST_ALERT_THRESHOLD:-750}"
RCA_CHAIN_CIRCUIT_BREAKER_THRESHOLD="${RCA_CHAIN_CIRCUIT_BREAKER_THRESHOLD:-3}"
RCA_CHAIN_CIRCUIT_BREAKER_COOLDOWN_S="${RCA_CHAIN_CIRCUIT_BREAKER_COOLDOWN_S:-3600}"
RCA_CHAIN_PRIMARY_PROVIDER="${RCA_CHAIN_PRIMARY_PROVIDER:-claude}"
RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS="${RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS:-6}"

_CHAIN_START_MS=0
_CHAIN_CALL_COUNT=0
_CHAIN_STAGES_COMPLETED=()
_CHAIN_ACTIVE_PROVIDER="${_CHAIN_ACTIVE_PROVIDER:-}"

_chain_state_dir() {
  printf '%s\n' "${INCIDENT_STATE_DIR:-/tmp/openclaw-state}"
}

_chain_circuit_breaker_file() {
  local dir
  dir="$(_chain_state_dir)"
  printf '%s\n' "${dir%/}/chain-circuit-breaker.tsv"
}

_chain_call_counter_file() {
  local dir
  dir="$(_chain_state_dir)"
  printf '%s\n' "${dir%/}/chain-call-counter.tsv"
}

_chain_now_ms() {
  local ms
  ms="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ms" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$ms"
    return 0
  fi
  printf '%s\n' "$(( $(date +%s) * 1000 ))"
}

_chain_now_s() {
  date +%s
}

_chain_with_lock() {
  local lock_file="$1"
  shift
  mkdir -p "${lock_file%/*}"

  if command -v flock >/dev/null 2>&1; then
    local fd
    exec {fd}>"$lock_file"
    flock -x "$fd"
    local rc=0
    if "$@"; then
      rc=0
    else
      rc=$?
    fi
    flock -u "$fd" >/dev/null 2>&1 || true
    eval "exec ${fd}>&-"
    return "$rc"
  fi

  "$@"
}

_chain_budget_remaining() {
  local now_ms elapsed remaining
  now_ms="$(_chain_now_ms)"
  elapsed=$((now_ms - _CHAIN_START_MS))
  remaining=$((RCA_CHAIN_TOTAL_TIMEOUT_MS - elapsed))
  printf '%s\n' "$remaining"
}

_chain_can_start_stage() {
  local remaining
  remaining="$(_chain_budget_remaining)"
  [[ "$remaining" =~ ^-?[0-9]+$ ]] || return 1
  (( remaining >= RCA_STAGE_TIMEOUT_MS ))
}

_chain_json_or_null() {
  local payload="${1:-}"
  if [[ -n "$payload" ]] && command -v jq >/dev/null 2>&1 && printf '%s\n' "$payload" | jq -e . >/dev/null 2>&1; then
    printf '%s\n' "$payload"
    return 0
  fi
  printf 'null\n'
}

_chain_is_json() {
  local payload="${1:-}"
  command -v jq >/dev/null 2>&1 && printf '%s\n' "$payload" | jq -e . >/dev/null 2>&1
}

_chain_read_circuit_locked() {
  local file
  file="$(_chain_circuit_breaker_file)"
  local failures=0 last_failure_ts=0

  if [[ -f "$file" ]]; then
    IFS=$'\t' read -r failures last_failure_ts <"$file" 2>/dev/null || true
  fi

  [[ "$failures" =~ ^[0-9]+$ ]] || failures=0
  [[ "$last_failure_ts" =~ ^[0-9]+$ ]] || last_failure_ts=0
  printf '%s\t%s\n' "$failures" "$last_failure_ts"
}

_chain_write_circuit_locked() {
  local failures="$1"
  local last_failure_ts="$2"
  local file tmp
  file="$(_chain_circuit_breaker_file)"
  mkdir -p "${file%/*}"
  tmp="${file}.tmp.$$"
  printf '%s\t%s\n' "$failures" "$last_failure_ts" >"$tmp"
  mv -f "$tmp" "$file"
}

_chain_record_failure_locked() {
  local row failures last_failure_ts
  row="$(_chain_read_circuit_locked)"
  failures="$(printf '%s\n' "$row" | awk -F'\t' '{print $1}')"
  last_failure_ts="$(printf '%s\n' "$row" | awk -F'\t' '{print $2}')"
  [[ "$failures" =~ ^[0-9]+$ ]] || failures=0
  [[ "$last_failure_ts" =~ ^[0-9]+$ ]] || last_failure_ts=0
  failures=$((failures + 1))
  last_failure_ts="$(_chain_now_s)"
  _chain_write_circuit_locked "$failures" "$last_failure_ts"
}

_chain_record_success_locked() {
  local row last_failure_ts
  row="$(_chain_read_circuit_locked)"
  last_failure_ts="$(printf '%s\n' "$row" | awk -F'\t' '{print $2}')"
  [[ "$last_failure_ts" =~ ^[0-9]+$ ]] || last_failure_ts=0
  _chain_write_circuit_locked "0" "$last_failure_ts"
}

_chain_record_failure() {
  local file
  file="$(_chain_circuit_breaker_file)"
  _chain_with_lock "${file}.lock" _chain_record_failure_locked
}

_chain_record_success() {
  local file
  file="$(_chain_circuit_breaker_file)"
  _chain_with_lock "${file}.lock" _chain_record_success_locked
}

_chain_circuit_breaker_open_locked() {
  local row failures last_failure_ts now age
  row="$(_chain_read_circuit_locked)"
  failures="$(printf '%s\n' "$row" | awk -F'\t' '{print $1}')"
  last_failure_ts="$(printf '%s\n' "$row" | awk -F'\t' '{print $2}')"
  [[ "$failures" =~ ^[0-9]+$ ]] || failures=0
  [[ "$last_failure_ts" =~ ^[0-9]+$ ]] || last_failure_ts=0

  if (( failures < RCA_CHAIN_CIRCUIT_BREAKER_THRESHOLD )); then
    return 1
  fi

  now="$(_chain_now_s)"
  age=$((now - last_failure_ts))
  if (( age >= RCA_CHAIN_CIRCUIT_BREAKER_COOLDOWN_S )); then
    _chain_write_circuit_locked "0" "$last_failure_ts"
    return 1
  fi

  return 0
}

_chain_circuit_breaker_open() {
  local file
  file="$(_chain_circuit_breaker_file)"
  _chain_with_lock "${file}.lock" _chain_circuit_breaker_open_locked
}

_chain_increment_call_counter_locked() {
  local file today current_date count
  file="$(_chain_call_counter_file)"
  mkdir -p "${file%/*}"
  today="$(date -u +%Y-%m-%d)"
  current_date=""
  count=0

  if [[ -f "$file" ]]; then
    IFS=$'\t' read -r current_date count <"$file" 2>/dev/null || true
  fi

  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  if [[ "$current_date" != "$today" ]]; then
    count=0
  fi

  count=$((count + 1))
  printf '%s\t%s\n' "$today" "$count" >"$file"
  printf '%s\n' "$count"
}

_chain_increment_call_counter() {
  local file
  file="$(_chain_call_counter_file)"
  _chain_with_lock "${file}.lock" _chain_increment_call_counter_locked
}

_chain_cost_breaker_tripped() {
  if [[ "${RCA_CHAIN_COST_ALERT_THRESHOLD:-0}" == "0" ]]; then
    return 1
  fi
  local count
  count="$(_chain_increment_call_counter)"
  [[ "$count" =~ ^[0-9]+$ ]] || return 1
  (( count > RCA_CHAIN_COST_ALERT_THRESHOLD ))
}

_chain_stages_for_severity() {
  local severity="${1:-medium}"
  severity="$(printf '%s' "$severity" | tr '[:upper:]' '[:lower:]')"
  case "$severity" in
    critical | high)
      if [[ "${RCA_CHAIN_STAGE_E_ENABLED:-0}" == "1" ]]; then
        printf 'A B C D E\n'
      else
        printf 'A B C D\n'
      fi
      ;;
    medium)
      printf 'A B C D\n'
      ;;
    low)
      printf 'A B\n'
      ;;
    info)
      printf 'A\n'
      ;;
    *)
      printf 'A B C D\n'
      ;;
  esac
}

_chain_list_has_stage() {
  local stage_list="$1"
  local wanted="$2"
  local stage
  for stage in $stage_list; do
    if [[ "$stage" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

_chain_completed_json() {
  if ! command -v jq >/dev/null 2>&1; then
    printf '[]\n'
    return 0
  fi
  if [[ "${#_CHAIN_STAGES_COMPLETED[@]}" -eq 0 ]]; then
    printf '[]\n'
    return 0
  fi
  printf '%s\n' "${_CHAIN_STAGES_COMPLETED[@]}" | awk 'NF > 0 { print }' | jq -R . | jq -s .
}

_chain_target_json() {
  local target_stages="$1"
  if ! command -v jq >/dev/null 2>&1; then
    printf '[]\n'
    return 0
  fi
  printf '%s\n' "$target_stages" | tr ' ' '\n' | awk 'NF > 0 { print }' | jq -R . | jq -s .
}

_chain_mode_from_completion() {
  local target_stages="$1"
  local completed_csv=""
  if [[ "${#_CHAIN_STAGES_COMPLETED[@]}" -gt 0 ]]; then
    completed_csv="$(printf '%s,' "${_CHAIN_STAGES_COMPLETED[@]}")"
  fi

  if [[ "$completed_csv" != *"D,"* ]]; then
    printf 'chain_v2_partial\n'
    return 0
  fi

  if _chain_list_has_stage "$target_stages" "E" && [[ "$completed_csv" != *"E,"* ]]; then
    printf 'chain_v2_partial\n'
    return 0
  fi

  printf 'chain_v2\n'
}

_chain_call_llm() {
  local stage="$1"
  local system_prompt="$2"
  local user_prompt="$3"
  local model_tier="${4:-fast}"
  local provider="${_CHAIN_ACTIVE_PROVIDER:-$RCA_CHAIN_PRIMARY_PROVIDER}"
  local combined_prompt
  (( _CHAIN_CALL_COUNT = _CHAIN_CALL_COUNT + 1 ))

  if _chain_cost_breaker_tripped; then
    printf '{"error":"cost_breaker_tripped"}\n' >&2
    return 1
  fi

  if declare -F _chain_llm_call >/dev/null 2>&1; then
    _chain_llm_call "$stage" "$user_prompt" "$system_prompt" "$model_tier"
    return $?
  fi

  combined_prompt="$(
    printf '%s\n\n%s\n\n%s\n' \
      "Stage ${stage} (${model_tier})" \
      "$system_prompt" \
      "$user_prompt"
  )"

  case "$provider" in
    claude)
      if declare -F call_claude_rca >/dev/null 2>&1; then
        call_claude_rca "$combined_prompt" "$RCA_STAGE_TIMEOUT_MS"
        return $?
      fi
      return 127
      ;;
    codex|*)
      if declare -F call_codex_rca >/dev/null 2>&1; then
        call_codex_rca "$combined_prompt" "$RCA_STAGE_TIMEOUT_MS"
        return $?
      fi
      return 127
      ;;
  esac
}

_chain_dual_review_refine() {
  local provider="$1"
  local evidence="$2"
  local peer_rca="$3"
  local current_rca="$4"
  local round="$5"
  local system_prompt user_prompt refined previous_provider

  system_prompt="You are an SRE RCA reviewer. Reconcile your RCA with peer analysis. If peer is stronger, align and set agree_with_peer=true. Return strict JSON only."
  user_prompt="$(
    printf '%s\n\n%s\n\n%s\n\n%s\n\n%s\n' \
      "Round: ${round}" \
      "Evidence:" \
      "$evidence" \
      "Peer RCA JSON:" \
      "$peer_rca"
  )"$'\n\n'"Current RCA JSON:"$'\n'"$current_rca"$'\n\n'"Return full RCA JSON with fields: severity, canonical_category, summary, root_cause, hypotheses[0], agree_with_peer."

  previous_provider="${_CHAIN_ACTIVE_PROVIDER:-}"
  _CHAIN_ACTIVE_PROVIDER="$provider"
  if ! refined="$(_chain_call_llm "R" "$system_prompt" "$user_prompt" "strong" 2>/dev/null)"; then
    _CHAIN_ACTIVE_PROVIDER="$previous_provider"
    printf '%s\n' "$current_rca"
    return 0
  fi

  if ! _chain_is_json "$refined"; then
    _CHAIN_ACTIVE_PROVIDER="$previous_provider"
    printf '%s\n' "$current_rca"
    return 0
  fi

  _CHAIN_ACTIVE_PROVIDER="$previous_provider"
  printf '%s\n' "$refined"
}

_chain_dual_attach_metadata() {
  local merged="$1"
  local review_rounds="$2"
  local max_rounds="$3"
  local codex_available="$4"
  local claude_available="$5"

  if ! command -v jq >/dev/null 2>&1 || ! _chain_is_json "$merged"; then
    printf '%s\n' "$merged"
    return 0
  fi

  printf '%s\n' "$merged" | jq -c \
    --argjson review_rounds "$review_rounds" \
    --argjson max_rounds "$max_rounds" \
    --argjson codex_available "$codex_available" \
    --argjson claude_available "$claude_available" \
    '
      .review_rounds = $review_rounds
      | .chain_metadata = (.chain_metadata // {})
      | .chain_metadata.dual_review = {
          enabled: true,
          review_rounds: $review_rounds,
          max_rounds: $max_rounds,
          codex_available: ($codex_available == 1),
          claude_available: ($claude_available == 1)
        }
    '
}

_chain_stage_a() {
  local evidence="$1"
  local service_ctx="$2"
  _chain_call_llm \
    "A" \
    "You are an SRE evidence triage agent. Extract the primary reported symptom first, keep uncertain clues separate, and note explicit human corrections." \
    "Evidence:\n${evidence}\n\nService context:\n${service_ctx}\n\nReturn JSON: primary_reported_symptom, secondary_clues, uncertain_clues, explicit_human_corrections, signals, noise, signal_count, explains_primary_symptom." \
    "fast"
}

_chain_stage_b() {
  local stage_a="$1"
  local service_ctx="$2"
  local incident_memory="$3"
  _chain_call_llm \
    "B" \
    "You are an SRE hypothesis generation agent. Generate hypotheses that explain the primary reported symptom before any secondary clue." \
    "Signals:\n${stage_a}\n\nService context:\n${service_ctx}\n\nIncident memory:\n${incident_memory}\n\nReturn JSON with hypotheses, top_hypothesis_id, explains_primary_symptom." \
    "fast"
}

_chain_stage_c() {
  local stage_b="$1"
  local service_ctx="$2"
  _chain_call_llm \
    "C" \
    "You are an SRE causal chain analyst." \
    "Hypotheses:\n${stage_b}\n\nService context:\n${service_ctx}\n\nReturn JSON causal_chain + gaps." \
    "strong"
}

_chain_stage_d() {
  local stage_c="$1"
  local service_ctx="$2"
  local revision_notes="${3:-}"
  _chain_call_llm \
    "D" \
    "You are an SRE action planner. Prefer specific actions tied to evidence." \
    "Causal chain:\n${stage_c}\n\nService context:\n${service_ctx}\n\nRevision notes:\n${revision_notes}\n\nReturn JSON actions + action_plan_quality." \
    "strong"
}

_chain_stage_e() {
  local stage_a="$1"
  local stage_b="$2"
  local stage_c="$3"
  local stage_d="$4"
  _chain_call_llm \
    "E" \
    "You are an SRE cross-review agent. Validate chain completeness, action safety, and whether the final theory actually explains the primary reported symptom." \
    "Evidence triage:\n${stage_a}\n\nHypotheses:\n${stage_b}\n\nCausal chain:\n${stage_c}\n\nAction plan:\n${stage_d}\n\nReturn JSON validated/review_pass/revision_notes/explains_primary_symptom." \
    "strong"
}

_chain_assemble_output() {
  local severity="$1"
  local stage_a="$2"
  local stage_b="$3"
  local stage_c="$4"
  local stage_d="$5"
  local stage_e="$6"
  local target_stages="$7"
  local root_override="${8:-}"
  local summary_override="${9:-}"
  local mode total_latency remaining_budget stages_json target_json
  local stage_a_json stage_b_json stage_c_json stage_d_json stage_e_json
  local fallback_summary fallback_root

  fallback_summary="Insufficient evidence for full analysis"
  fallback_root="[NEEDS REVIEW]"
  if [[ -n "$summary_override" ]]; then
    fallback_summary="$summary_override"
  fi
  if [[ -n "$root_override" ]]; then
    fallback_root="$root_override"
  fi

  mode="$(_chain_mode_from_completion "$target_stages")"
  total_latency=$(( $(_chain_now_ms) - _CHAIN_START_MS ))
  remaining_budget="$(_chain_budget_remaining)"
  stages_json="$(_chain_completed_json)"
  target_json="$(_chain_target_json "$target_stages")"
  stage_a_json="$(_chain_json_or_null "$stage_a")"
  stage_b_json="$(_chain_json_or_null "$stage_b")"
  stage_c_json="$(_chain_json_or_null "$stage_c")"
  stage_d_json="$(_chain_json_or_null "$stage_d")"
  stage_e_json="$(_chain_json_or_null "$stage_e")"

  if ! command -v jq >/dev/null 2>&1; then
    printf '{"severity":"%s","canonical_category":"unknown","summary":"%s","root_cause":"%s","hypotheses":[{"hypothesis_id":"unknown:insufficient_evidence","canonical_category":"unknown","description":"Insufficient evidence for hypothesis generation","confidence":0}],"rca_confidence":0,"mode":"%s","chain_metadata":{"stages_completed":[]}}\n' \
      "$severity" "$fallback_summary" "$fallback_root" "$mode"
    return 0
  fi

  jq -cn \
    --arg severity "$severity" \
    --arg mode "$mode" \
    --arg fallback_summary "$fallback_summary" \
    --arg fallback_root "$fallback_root" \
    --argjson total_latency "$total_latency" \
    --argjson remaining_budget "$remaining_budget" \
    --argjson call_count "$_CHAIN_CALL_COUNT" \
    --argjson stages "$stages_json" \
    --argjson target "$target_json" \
    --argjson stage_a "$stage_a_json" \
    --argjson stage_b "$stage_b_json" \
    --argjson stage_c "$stage_c_json" \
    --argjson stage_d "$stage_d_json" \
    --argjson stage_e "$stage_e_json" \
    '
      def fallback_hypothesis:
        {
          hypothesis_id: "unknown:insufficient_evidence",
          canonical_category: "unknown",
          description: "Insufficient evidence for hypothesis generation",
          confidence: 0,
          supporting_evidence: [],
          contradicting_evidence: []
        };
      def top_hypothesis($b):
        if ($b|type) == "object" then
          (($b.hypotheses // [])[0] // {})
        else
          {}
        end;
      def from_stage_a($field; $default):
        if ($stage_a|type) == "object" then
          ($stage_a[$field] // $default)
        else
          $default
        end;
      def norm_bool($v):
        if $v == true then true
        elif $v == false or $v == null then false
        elif ($v|type) == "string" then
          (($v | ascii_downcase) as $s | ($s == "true" or $s == "yes" or $s == "1"))
        elif ($v|type) == "number" then
          ($v != 0)
        else false
        end;

      (top_hypothesis($stage_b)) as $top
      | {
          severity: $severity,
          canonical_category: ($top.canonical_category // "unknown"),
          summary: ($top.description // $fallback_summary),
          root_cause: (
            if ($stage_c|type) == "object" then
              ($stage_c.causal_chain.trigger // $fallback_root)
            else
              $fallback_root
            end
          ),
          hypotheses: (
            if ($stage_b|type) == "object" and (($stage_b.hypotheses // []) | length) > 0 then
              $stage_b.hypotheses
            else
              [fallback_hypothesis]
            end
          ),
          primary_reported_symptom: from_stage_a("primary_reported_symptom"; ""),
          secondary_clues: from_stage_a("secondary_clues"; []),
          uncertain_clues: from_stage_a("uncertain_clues"; []),
          explicit_human_corrections: from_stage_a("explicit_human_corrections"; []),
          explains_primary_symptom: norm_bool(
            if ($stage_e|type) == "object" and ($stage_e.explains_primary_symptom != null) then
              $stage_e.explains_primary_symptom
            elif ($stage_b|type) == "object" and ($stage_b.explains_primary_symptom != null) then
              $stage_b.explains_primary_symptom
            elif ($stage_a|type) == "object" and ($stage_a.explains_primary_symptom != null) then
              $stage_a.explains_primary_symptom
            else
              false
            end
          ),
          rca_confidence: (($top.confidence // 0) | tonumber? // 0),
          mode: $mode,
          chain_metadata: {
            stages_completed: $stages,
            stages_target: $target,
            total_latency_ms: ($total_latency | tonumber),
            remaining_budget_ms: ($remaining_budget | tonumber),
            llm_call_count: ($call_count | tonumber),
            evidence_triage: $stage_a,
            causal_chain: $stage_c,
            action_plan: $stage_d,
            cross_review: $stage_e
          }
        }
    '
}

_chain_fail_with_partial() {
  local severity="$1"
  local stage_a="$2"
  local stage_b="$3"
  local stage_c="$4"
  local stage_d="$5"
  local stage_e="$6"
  local target_stages="$7"
  local root_override="${8:-}"
  local summary_override="${9:-}"
  _chain_record_failure
  _chain_assemble_output \
    "$severity" \
    "$stage_a" \
    "$stage_b" \
    "$stage_c" \
    "$stage_d" \
    "$stage_e" \
    "$target_stages" \
    "$root_override" \
    "$summary_override"
}

_run_rca_chain_single_provider() {
  local evidence="${1:-}"
  local severity="${2:-medium}"
  local service_ctx="${3:-}"
  local incident_memory="${4:-}"
  local recollect_note="${RCA_RECOLLECT_NOTE:-}"
  local target_stages stage_a stage_b stage_c stage_d stage_e
  local signal_count result action_quality review_pass revision_notes

  severity="$(printf '%s' "$severity" | tr '[:upper:]' '[:lower:]')"
  _CHAIN_START_MS="$(_chain_now_ms)"
  _CHAIN_CALL_COUNT=0
  _CHAIN_STAGES_COMPLETED=()
  stage_a=""
  stage_b=""
  stage_c=""
  stage_d=""
  stage_e=""
  target_stages="$(_chain_stages_for_severity "$severity")"

  if _chain_circuit_breaker_open; then
    _chain_assemble_output \
      "$severity" "" "" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — chain circuit breaker open" \
      "Chain temporarily disabled by circuit breaker"
    return 0
  fi

  if ! _chain_can_start_stage; then
    _chain_assemble_output \
      "$severity" "" "" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — budget exhausted before Stage A" \
      "Insufficient budget for full analysis"
    _chain_record_success
    return 0
  fi

  if [[ -n "$recollect_note" ]]; then
    evidence="${evidence}"$'\n\n'"recollection_note"$'\n'"${recollect_note}"
  fi

  if ! stage_a="$(_chain_stage_a "$evidence" "$service_ctx" 2>/dev/null)"; then
    _chain_fail_with_partial \
      "$severity" "" "" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — Stage A failed" \
      "Evidence triage failed"
    return 0
  fi
  if ! _chain_is_json "$stage_a"; then
    _chain_fail_with_partial \
      "$severity" "" "" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — Stage A invalid JSON" \
      "Evidence triage failed"
    return 0
  fi
  _CHAIN_STAGES_COMPLETED+=("A")

  signal_count="$(printf '%s\n' "$stage_a" | jq -r '.signal_count // 0' 2>/dev/null || printf '0')"
  [[ "$signal_count" =~ ^[0-9]+$ ]] || signal_count=0
  if (( signal_count < 1 )); then
    result="$(_chain_assemble_output \
      "$severity" "$stage_a" "" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — insufficient evidence signals" \
      "Insufficient evidence for hypothesis generation")"
    _chain_record_success
    printf '%s\n' "$result"
    return 0
  fi

  if ! _chain_list_has_stage "$target_stages" "B"; then
    result="$(_chain_assemble_output "$severity" "$stage_a" "" "" "" "" "$target_stages")"
    _chain_record_success
    printf '%s\n' "$result"
    return 0
  fi

  if ! _chain_can_start_stage; then
    result="$(_chain_assemble_output "$severity" "$stage_a" "" "" "" "" "$target_stages")"
    _chain_record_success
    printf '%s\n' "$result"
    return 0
  fi

  if ! stage_b="$(_chain_stage_b "$stage_a" "$service_ctx" "$incident_memory" 2>/dev/null)"; then
    _chain_fail_with_partial \
      "$severity" "$stage_a" "" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — Stage B failed" \
      "Hypothesis generation failed"
    return 0
  fi
  if ! _chain_is_json "$stage_b"; then
    _chain_fail_with_partial \
      "$severity" "$stage_a" "" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — Stage B invalid JSON" \
      "Hypothesis generation failed"
    return 0
  fi
  _CHAIN_STAGES_COMPLETED+=("B")

  if ! _chain_list_has_stage "$target_stages" "C"; then
    result="$(_chain_assemble_output "$severity" "$stage_a" "$stage_b" "" "" "" "$target_stages")"
    _chain_record_success
    printf '%s\n' "$result"
    return 0
  fi

  if ! _chain_can_start_stage; then
    result="$(_chain_assemble_output "$severity" "$stage_a" "$stage_b" "" "" "" "$target_stages")"
    _chain_record_success
    printf '%s\n' "$result"
    return 0
  fi

  if ! stage_c="$(_chain_stage_c "$stage_b" "$service_ctx" 2>/dev/null)"; then
    _chain_fail_with_partial \
      "$severity" "$stage_a" "$stage_b" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — Stage C failed" \
      "Causal chain generation failed"
    return 0
  fi
  if ! _chain_is_json "$stage_c"; then
    _chain_fail_with_partial \
      "$severity" "$stage_a" "$stage_b" "" "" "" "$target_stages" \
      "[NEEDS REVIEW] — Stage C invalid JSON" \
      "Causal chain generation failed"
    return 0
  fi
  _CHAIN_STAGES_COMPLETED+=("C")

  if ! _chain_list_has_stage "$target_stages" "D"; then
    result="$(_chain_assemble_output "$severity" "$stage_a" "$stage_b" "$stage_c" "" "" "$target_stages")"
    _chain_record_success
    printf '%s\n' "$result"
    return 0
  fi

  if ! _chain_can_start_stage; then
    result="$(_chain_assemble_output "$severity" "$stage_a" "$stage_b" "$stage_c" "" "" "$target_stages")"
    _chain_record_success
    printf '%s\n' "$result"
    return 0
  fi

  if ! stage_d="$(_chain_stage_d "$stage_c" "$service_ctx" "" 2>/dev/null)"; then
    _chain_fail_with_partial \
      "$severity" "$stage_a" "$stage_b" "$stage_c" "" "" "$target_stages" \
      "[NEEDS REVIEW] — Stage D failed" \
      "Action plan generation failed"
    return 0
  fi
  if ! _chain_is_json "$stage_d"; then
    _chain_fail_with_partial \
      "$severity" "$stage_a" "$stage_b" "$stage_c" "" "" "$target_stages" \
      "[NEEDS REVIEW] — Stage D invalid JSON" \
      "Action plan generation failed"
    return 0
  fi
  _CHAIN_STAGES_COMPLETED+=("D")

  action_quality="$(printf '%s\n' "$stage_d" | jq -r '.action_plan_quality // "unknown"' 2>/dev/null || printf 'unknown')"
  if [[ "$action_quality" == "generic" ]] && _chain_can_start_stage; then
    local revised_stage_d
    revised_stage_d="$(_chain_stage_d "$stage_c" "$service_ctx" "Be specific: cite concrete evidence and commands." 2>/dev/null || true)"
    if _chain_is_json "$revised_stage_d"; then
      stage_d="$revised_stage_d"
    fi
  fi

  if _chain_list_has_stage "$target_stages" "E"; then
    if _chain_can_start_stage; then
      stage_e="$(_chain_stage_e "$stage_a" "$stage_b" "$stage_c" "$stage_d" 2>/dev/null || true)"
      if _chain_is_json "$stage_e"; then
        _CHAIN_STAGES_COMPLETED+=("E")
        review_pass="$(printf '%s\n' "$stage_e" | jq -r '.review_pass // "accepted"' 2>/dev/null || printf 'accepted')"
        if [[ "$review_pass" == "revision_needed" ]] && _chain_can_start_stage; then
          revision_notes="$(printf '%s\n' "$stage_e" | jq -r '.revision_notes // ""' 2>/dev/null || true)"
          if stage_d="$(_chain_stage_d "$stage_c" "$service_ctx" "$revision_notes" 2>/dev/null)"; then
            if _chain_can_start_stage; then
              stage_e="$(_chain_stage_e "$stage_a" "$stage_b" "$stage_c" "$stage_d" 2>/dev/null || printf '%s\n' "$stage_e")"
            fi
          fi
        fi
      fi
    fi
  fi

  result="$(_chain_assemble_output "$severity" "$stage_a" "$stage_b" "$stage_c" "$stage_d" "$stage_e" "$target_stages")"
  if ! _chain_is_json "$result"; then
    result="$(_chain_fail_with_partial \
      "$severity" "$stage_a" "$stage_b" "$stage_c" "$stage_d" "$stage_e" "$target_stages" \
      "[NEEDS REVIEW] — chain assembler produced invalid JSON" \
      "Chain assembly failed")"
    printf '%s\n' "$result"
    return 0
  fi

  _chain_record_success
  printf '%s\n' "$result"
}

_chain_dual_compare_and_merge() {
  local evidence="$1"
  local codex_rca="$2"
  local claude_rca="$3"
  local max_rounds="$4"
  local codex_available="$5"
  local claude_available="$6"
  local round=0
  local cross_a cross_b merged next_a next_b

  cross_a="$codex_rca"
  cross_b="$claude_rca"

  if ! [[ "$max_rounds" =~ ^[0-9]+$ ]]; then
    max_rounds=6
  fi
  if (( max_rounds < 0 )); then
    max_rounds=6
  fi

  if [[ -z "$cross_a" || -z "$cross_b" ]]; then
    if declare -F run_cross_review >/dev/null 2>&1; then
      merged="$(run_cross_review 0 "$cross_a" "$cross_b" "$evidence" "$max_rounds" 2>/dev/null || true)"
      _chain_dual_attach_metadata "$merged" 0 "$max_rounds" "$codex_available" "$claude_available"
      return 0
    fi
    if [[ -n "$cross_a" ]]; then
      _chain_dual_attach_metadata "$cross_a" 0 "$max_rounds" "$codex_available" "$claude_available"
      return 0
    fi
    if [[ -n "$cross_b" ]]; then
      _chain_dual_attach_metadata "$cross_b" 0 "$max_rounds" "$codex_available" "$claude_available"
      return 0
    fi
    printf '{"mode":"heuristic","degradation_note":"Both LLM providers unavailable — heuristic fallback"}\n'
    return 0
  fi

  while true; do
    if declare -F check_convergence >/dev/null 2>&1 \
      && declare -F merge_rcas >/dev/null 2>&1 \
      && check_convergence "$cross_a" "$cross_b" "$round" >/dev/null 2>&1; then
      merged="$(merge_rcas "$cross_a" "$cross_b")"
      _chain_dual_attach_metadata "$merged" "$round" "$max_rounds" "$codex_available" "$claude_available"
      return 0
    fi

    if (( round >= max_rounds )); then
      if declare -F run_cross_review >/dev/null 2>&1; then
        merged="$(run_cross_review "$round" "$cross_a" "$cross_b" "$evidence" "$max_rounds" 2>/dev/null || true)"
      else
        merged="$cross_a"
      fi
      _chain_dual_attach_metadata "$merged" "$round" "$max_rounds" "$codex_available" "$claude_available"
      return 0
    fi

    next_a="$(_chain_dual_review_refine "codex" "$evidence" "$cross_b" "$cross_a" "$round" 2>/dev/null || true)"
    next_b="$(_chain_dual_review_refine "claude" "$evidence" "$cross_a" "$cross_b" "$round" 2>/dev/null || true)"
    if _chain_is_json "$next_a"; then
      cross_a="$next_a"
    fi
    if _chain_is_json "$next_b"; then
      cross_b="$next_b"
    fi
    round=$((round + 1))
  done
}

_run_rca_chain_dual_provider() {
  local evidence="$1"
  local severity="$2"
  local service_ctx="$3"
  local incident_memory="$4"
  local max_rounds="${RCA_CHAIN_DUAL_MAX_REVIEW_ROUNDS:-6}"
  local tmp_dir codex_rca claude_rca
  local codex_available=0
  local claude_available=0
  local pid_codex pid_claude

  tmp_dir="$(mktemp -d)"
  (
    _CHAIN_ACTIVE_PROVIDER="codex"
    _run_rca_chain_single_provider "$evidence" "$severity" "$service_ctx" "$incident_memory"
  ) >"${tmp_dir}/codex.json" 2>"${tmp_dir}/codex.err" &
  pid_codex=$!
  (
    _CHAIN_ACTIVE_PROVIDER="claude"
    _run_rca_chain_single_provider "$evidence" "$severity" "$service_ctx" "$incident_memory"
  ) >"${tmp_dir}/claude.json" 2>"${tmp_dir}/claude.err" &
  pid_claude=$!

  wait "$pid_codex" >/dev/null 2>&1 || true
  wait "$pid_claude" >/dev/null 2>&1 || true

  codex_rca="$(cat "${tmp_dir}/codex.json" 2>/dev/null || true)"
  claude_rca="$(cat "${tmp_dir}/claude.json" 2>/dev/null || true)"
  rm -rf "$tmp_dir"

  if ! _chain_is_json "$codex_rca"; then
    codex_rca=""
  else
    codex_available=1
  fi
  if ! _chain_is_json "$claude_rca"; then
    claude_rca=""
  else
    claude_available=1
  fi

  _chain_dual_compare_and_merge \
    "$evidence" \
    "$codex_rca" \
    "$claude_rca" \
    "$max_rounds" \
    "$codex_available" \
    "$claude_available"
}

run_rca_chain() {
  local evidence="${1:-}"
  local severity="${2:-medium}"
  local service_ctx="${3:-}"
  local incident_memory="${4:-}"
  local mode="${5:-single}"

  mode="$(printf '%s' "$mode" | tr '[:upper:]' '[:lower:]')"
  case "$mode" in
    dual)
      _run_rca_chain_dual_provider "$evidence" "$severity" "$service_ctx" "$incident_memory"
      ;;
    *)
      _CHAIN_ACTIVE_PROVIDER="$RCA_CHAIN_PRIMARY_PROVIDER"
      _run_rca_chain_single_provider "$evidence" "$severity" "$service_ctx" "$incident_memory"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
