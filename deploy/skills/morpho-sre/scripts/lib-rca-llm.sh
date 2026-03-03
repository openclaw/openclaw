#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/lib-rca-prompt.sh" ]]; then
  # shellcheck source=lib-rca-prompt.sh
  source "${SCRIPT_DIR}/lib-rca-prompt.sh"
fi

RCA_LLM_TIMEOUT_MS="${RCA_LLM_TIMEOUT_MS:-15000}"

call_codex_rca() {
  local prompt="${1:-}"
  local timeout_ms="${2:-$RCA_LLM_TIMEOUT_MS}"
  local timeout_seconds
  timeout_seconds="$(awk -v ms="$timeout_ms" 'BEGIN { printf "%.3f", ms / 1000.0 }')"

  if declare -F codex_rca_provider >/dev/null 2>&1; then
    codex_rca_provider "$prompt"
    return $?
  fi

  if [[ -n "${RCA_CODEX_PROVIDER_SCRIPT:-}" && -x "${RCA_CODEX_PROVIDER_SCRIPT}" ]]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout "$timeout_seconds" "$RCA_CODEX_PROVIDER_SCRIPT" "$prompt"
      return $?
    fi
    "$RCA_CODEX_PROVIDER_SCRIPT" "$prompt"
    return $?
  fi

  return 127
}

fallback_heuristic_rca() {
  local evidence_bundle="${1:-}"
  local summary
  summary="$(printf '%s\n' "$evidence_bundle" | head -n 3 | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g')"
  [[ -z "$summary" ]] && summary="heuristic fallback"

  cat <<EOF_JSON
{"mode":"heuristic","severity":"medium","canonical_category":"unknown","summary":"${summary}","root_cause":"[NEEDS REVIEW]","hypotheses":[{"canonical_category":"unknown","hypothesis_id":"unknown:insufficient_evidence","confidence":40,"description":"heuristic fallback due to llm unavailability","evidence_keys":[]}],"degradation_note":"RCA generated via heuristic fallback"}
EOF_JSON
}

_llm_attach_mode() {
  local json_payload="$1"
  local mode="$2"
  local note="${3:-}"

  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$json_payload" | jq -c --arg mode "$mode" --arg note "$note" '
      .mode = $mode
      | .degradation_note = (if $note == "" then (.degradation_note // null) else $note end)
    '
    return 0
  fi

  printf '%s\n' "$json_payload"
}

run_step_11() {
  local evidence_bundle="${1:-}"
  local mode="${2:-single}"
  local incident_state="${3:-incident}"
  local linear_matches="${4:-}"
  local skill_snippets="${5:-}"
  local service_context=""

  if [[ "$incident_state" != "incident" ]]; then
    printf '{"status":"skipped","reason":"healthy","mode":"%s"}\n' "$mode"
    return 0
  fi

  if [[ "$mode" == "heuristic" ]]; then
    fallback_heuristic_rca "$evidence_bundle"
    return 0
  fi

  if declare -F assemble_service_context >/dev/null 2>&1; then
    service_context="$(assemble_service_context \
      "${K8S_CONTEXT:-unknown}" \
      "${step11_dedup_namespace:-unknown}" \
      "${step11_primary_service:-unknown}" 2>/dev/null || true)"
  elif [[ -n "${RCA_SERVICE_CONTEXT:-}" ]]; then
    service_context="${RCA_SERVICE_CONTEXT}"
  fi

  # Chain mode (feature-flagged) replaces legacy single-shot/dual convergence.
  if [[ "${RCA_CHAIN_ENABLED:-0}" == "1" ]]; then
    if [[ "$mode" == "dual" ]]; then
      printf '%s\n' "WARN: RCA_CHAIN_ENABLED=1 overrides RCA_MODE=dual -- chain Stage E replaces external dual-mode convergence. Set RCA_MODE=single to suppress." >&2
    fi
    if declare -F run_rca_chain >/dev/null 2>&1; then
      run_rca_chain "$evidence_bundle" "${severity_level:-medium}" "${service_context:-}" "${linear_matches:-}"
      return 0
    fi
    printf '%s\n' "WARN: RCA_CHAIN_ENABLED=1 but lib-rca-chain.sh not loaded, falling back to single-shot" >&2
  fi

  local prompt
  if declare -F build_rca_prompt >/dev/null 2>&1; then
    prompt="$(build_rca_prompt "$evidence_bundle" "$linear_matches" "$skill_snippets")"
  else
    prompt="$evidence_bundle"
  fi

  local output
  local rc=0
  if output="$(call_codex_rca "$prompt" "$RCA_LLM_TIMEOUT_MS" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi

  if [[ "$rc" -ne 0 || -z "$output" ]]; then
    local fallback_json
    fallback_json="$(fallback_heuristic_rca "$evidence_bundle")"
    _llm_attach_mode "$fallback_json" "$mode" "Codex unavailable — heuristic fallback"
    return 0
  fi

  if declare -F validate_rca_output >/dev/null 2>&1; then
    output="$(validate_rca_output "$output" 2>/dev/null || printf '%s\n' "$output")"
  fi

  _llm_attach_mode "$output" "$mode" ""
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
