#!/usr/bin/env bash

rewards_provider_should_collect() {
  local combined="${1:-}"
  case "$combined" in
    *merkl* | *v4/opportunities/campaigns* | *yearly_supply_tokens* | *campaigns.morpho.org* | *campaign\ tvl* | *reward\ apr* | *rewards\ apr* | *supply\ apr* | *borrow\ apr* | *supplyapr* | *borrowapr* | *reward\ program* | *rewards\ program*)
      return 0
      ;;
  esac
  return 1
}

rewards_provider_sanitize_signal_line() {
  local raw="${1:-}"
  local sanitized=""
  if declare -F sanitize_signal_line >/dev/null 2>&1; then
    sanitize_signal_line "$raw"
    return
  fi
  if [[ -z "$raw" ]]; then
    printf '\n'
    return
  fi
  if ! sanitized="$(
    printf '%s\n' "$raw" \
      | jq -Rr '
          gsub("(?i)(authorization:[[:space:]]*bearer[[:space:]]+)[A-Za-z0-9._/+=-]{16,}"; "\\1<redacted>")
          | gsub("(?i)(xox[baprs]-)[A-Za-z0-9-]+"; "\\1<redacted>")
          | gsub("(?i)(xapp-[0-9]+-)[A-Za-z0-9-]+"; "\\1<redacted>")
          | gsub("(?i)(gh[pousr]_[A-Za-z0-9_]+)"; "<redacted-gh-token>")
          | gsub("(?i)github_pat_[A-Za-z0-9_]+"; "<redacted-gh-token>")
          | gsub("AKIA[0-9A-Z]{16}"; "<redacted-aws-key>")
          | gsub("ASIA[0-9A-Z]{16}"; "<redacted-aws-sts-key>")
          | gsub("(?i)sk-ant-[A-Za-z0-9._=-]+"; "sk-ant-<redacted>")
          | gsub("(?i)hvs\\.[A-Za-z0-9._=-]+"; "hvs.<redacted>")
          | gsub("(?i)\\bs\\.[A-Za-z0-9._=-]{8,}\\b"; "s.<redacted>")
          | gsub("(?i)(\"?(password|secret|token|api_key|aws_secret_access_key|private_key|client_secret)\"?[[:space:]]*[:=][[:space:]]*\")([^\"\\r\\n]{4,})(\")"; "\\1<redacted>\\4")
          | gsub("(?i)(\"?(password|secret|token|api_key|aws_secret_access_key|private_key|client_secret)\"?[[:space:]]*[:=][[:space:]]*)([^[:space:]\",}{]{4,})"; "\\1<redacted>")
          | gsub("(?i)((cert|certificate|private[_-]?key|tls\\.crt|tls\\.key)[[:space:]]*[:=][[:space:]]*)([A-Za-z0-9+/=]{40,})"; "\\1<redacted-cert-data>")
          | gsub("[\r\n\t]+"; " ")
          | gsub("[[:space:]]+"; " ")
          | .[0:220]
        ' 2>/dev/null
  )"; then
    if [[ "${DEBUG:-0}" == "1" ]]; then
      printf 'rewards_provider_sanitize_signal_line: jq sanitization failed, using fallback\n' >&2
    fi
    sanitized="$(printf '%s' "$raw" | tr '\r\n\t' '   ' | tr -s ' ' | cut -c1-220)"
  fi
  printf '%s\n' "$sanitized"
}

rewards_provider_has_same_token_signal() {
  local combined="${1:-}"
  case "$combined" in
    *"phantom supply"* | *"double-counted"* | *"double-counting"*)
      return 0
      ;;
  esac
  if [[ "$combined" == *"same reward token"* && "$combined" == *"supply"* && "$combined" == *"borrow"* ]]; then
    return 0
  fi
  if [[ "$combined" == *"borrow-only"* && "$combined" == *"supply"* && ( "$combined" == *"reward"* || "$combined" == *"campaign"* || "$combined" == *"apr"* ) ]]; then
    return 0
  fi
  if [[ "$combined" == *"supplyapr"* && "$combined" == *"borrowapr"* ]]; then
    return 0
  fi
  return 1
}

rewards_provider_first_same_token_signal_line() {
  local raw="${1:-}" line lowered
  while IFS= read -r line; do
    lowered="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
    if rewards_provider_has_same_token_signal "$lowered"; then
      printf '%s\n' "$line"
      return 0
    fi
  done <<<"$raw"
  return 1
}

rewards_provider_has_disproved_theory_signal() {
  local combined="${1:-}"
  case "$combined" in
    *"not sure about the fix"* | *"cannot be around"* | *"wrong fix"* | *"disproved theory"*)
      return 0
      ;;
  esac
  return 1
}

collect_phase2_rewards_provider_context() {
  rewards_provider_mode=0
  rewards_provider_live_probe_expected=0
  primary_symptom_replay=0
  provider_entity_liveness=0
  db_row_provenance=0
  provider_api_check=0
  provider_side_mismatch=0
  artifact_check=0
  code_path_check=0
  code_path_reconciled=0
  disproved_theory_recorded=0
  disproved_theory_expected=0
  same_token_both_sides_expected=0
  rewards_provider_context_note=""
  primary_symptom_replay_evidence_output=""
  provider_entity_liveness_evidence_output=""
  db_row_provenance_evidence_output=""
  provider_api_evidence_output=""
  provider_side_mismatch_evidence_output=""
  artifact_evidence_output=""
  code_path_evidence_output=""
  code_path_reconciled_evidence_output=""
  disproved_theory_evidence_output=""

  local raw_combined combined
  local primary_symptom_replay_evidence_output_local provider_entity_liveness_evidence_output_local
  local db_row_provenance_evidence_output_local provider_api_evidence_output_local
  local provider_side_mismatch_evidence_output_local artifact_evidence_output_local
  local code_path_evidence_output_local code_path_reconciled_evidence_output_local
  local disproved_theory_evidence_output_local
  local base_evidence_incomplete=0 same_token_evidence_incomplete=0 disproved_theory_incomplete=0

  raw_combined="$(
    {
      printf '%s\n' "${BETTERSTACK_CONTEXT:-}"
      printf '%s\n' "${alert_rows:-}"
      printf '%s\n' "${event_rows:-}"
      printf '%s\n' "${log_signal_rows:-}"
      printf '%s\n' "${db_evidence_rows:-}"
      printf '%s\n' "${repo_map_rows:-}"
      printf '%s\n' "${revision_rows:-}"
      printf '%s\n' "${ci_rows:-}"
      printf '%s\n' "${changes_in_window_summary:-}"
    }
  )"
  combined="$(printf '%s' "$raw_combined" | tr '[:upper:]' '[:lower:]')"

  rewards_provider_should_collect "$combined" || {
    if [[ "${DEBUG:-0}" == "1" ]]; then
      printf 'collect_phase2_rewards_provider_context: rewards_provider_should_collect returned false, skipping collection\n' >&2
    fi
    return 0
  }
  rewards_provider_mode=1

  db_row_provenance_evidence_output_local="$(printf '%s' "${db_row_provenance_evidence_input:-}" | awk 'NF > 0 { print }')"
  provider_api_evidence_output_local="$(printf '%s' "${provider_api_evidence_input:-}" | awk 'NF > 0 { print }')"
  provider_side_mismatch_evidence_output_local="$(printf '%s' "${provider_side_mismatch_evidence_input:-}" | awk 'NF > 0 { print }')"
  artifact_evidence_output_local="$(printf '%s' "${artifact_evidence_input:-}" | awk 'NF > 0 { print }')"
  code_path_evidence_output_local="$(printf '%s' "${code_path_evidence_input:-}" | awk 'NF > 0 { print }')"
  code_path_reconciled_evidence_output_local="$(printf '%s' "${code_path_reconciled_evidence_input:-}" | awk 'NF > 0 { print }')"
  disproved_theory_evidence_output_local="$(printf '%s' "${disproved_theory_evidence_input:-}" | awk 'NF > 0 { print }')"

  if [[ -z "$db_row_provenance_evidence_output_local" ]]; then
    db_row_provenance_evidence_output_local="$(
      printf '%s\n' "$raw_combined" \
        | grep -Eim1 '(market_historical_state_rewards|vault_v2_reward_programs|reward row|program_key|supply_apr|borrow_apr|yearly_supply_tokens|yearly_borrow_tokens|asset_id|market_historical_state_id)' \
        || true
    )"
  fi

  primary_symptom_replay_evidence_output_local="$(printf '%s' "${primary_symptom_replay_evidence_input:-}" | awk 'NF > 0 { print; exit }')"
  provider_entity_liveness_evidence_output_local="$(printf '%s' "${provider_entity_liveness_evidence_input:-}" | awk 'NF > 0 { print; exit }')"
  if [[ -n "$primary_symptom_replay_evidence_output_local" || -n "$provider_entity_liveness_evidence_output_local" ]]; then
    rewards_provider_live_probe_expected=1
  fi

  if [[ -z "$provider_api_evidence_output_local" ]]; then
    provider_api_evidence_output_local="$(
      printf '%s\n' "$raw_combined" \
        | grep -Eom1 '(GET /v4/opportunities/campaigns[^[:space:]]*|https?://[^[:space:]]*api\.merkl[^[:space:]]*|campaigns\.morpho\.org[^[:space:]]*)' \
        || true
    )"
  fi

  if [[ -z "$provider_side_mismatch_evidence_output_local" ]]; then
    provider_side_mismatch_evidence_output_local="$(rewards_provider_first_same_token_signal_line "$raw_combined" || true)"
  fi

  if [[ -z "$artifact_evidence_output_local" ]]; then
    if [[ -n "${changes_in_window_summary:-}" ]] && printf '%s\n' "${changes_in_window_summary:-}" | grep -Eiq '(artifact|snapshot|dump|cache|workflow)'; then
      artifact_evidence_output_local="$(rewards_provider_sanitize_signal_line "$changes_in_window_summary")"
    elif [[ -n "${ci_rows:-}" ]]; then
      artifact_evidence_output_local="$(rewards_provider_sanitize_signal_line "$(printf '%s\n' "$ci_rows" | awk 'NF > 0 { print; exit }')")"
    fi
  fi

  if [[ -z "$code_path_evidence_output_local" ]]; then
    code_path_evidence_output_local="$(
      printf '%s\n' "$raw_combined" \
        | grep -Eom1 '(src/|apps/|scripts/|test/|skills/|extensions/|packages/|docs/)([A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.(ts|tsx|js|jsx|sql|ya?ml|json|sh)(:[0-9]+)?' \
        || true
    )"
  fi

  if [[ -z "$code_path_reconciled_evidence_output_local" ]]; then
    code_path_reconciled_evidence_output_local="$(
      printf '%s\n' "$raw_combined" \
        | grep -Eim1 '(_fetchMerklSingleRates|marketRewards\.reduce|already merges|current code path|not the root cause|does not address the active code path|sync only deletes|contradicts active code|reconciled active code path)' \
        || true
    )"
  fi

  if [[ -n "$db_row_provenance_evidence_output_local" ]]; then
    db_row_provenance_evidence_output_local="$(rewards_provider_sanitize_signal_line "$db_row_provenance_evidence_output_local")"
    db_row_provenance=1
  fi

  # These gates stay closed until a dedicated live probe records explicit
  # evidence for the exact user-visible mismatch and provider entity state.
  if [[ -n "$primary_symptom_replay_evidence_output_local" ]]; then
    primary_symptom_replay_evidence_output_local="$(rewards_provider_sanitize_signal_line "$primary_symptom_replay_evidence_output_local")"
    primary_symptom_replay=1
  elif [[ "$rewards_provider_mode" == "1" && "${DEBUG:-0}" == "1" ]]; then
    printf 'collect_phase2_rewards_provider_context: primary_symptom_replay missing explicit evidence input; gate remains closed\n' >&2
  fi

  if [[ -n "$provider_api_evidence_output_local" ]]; then
    provider_api_evidence_output_local="$(rewards_provider_sanitize_signal_line "$provider_api_evidence_output_local")"
    provider_api_check=1
  fi

  if [[ -n "$provider_entity_liveness_evidence_output_local" ]]; then
    provider_entity_liveness_evidence_output_local="$(rewards_provider_sanitize_signal_line "$provider_entity_liveness_evidence_output_local")"
    provider_entity_liveness=1
  elif [[ "$rewards_provider_mode" == "1" && "${DEBUG:-0}" == "1" ]]; then
    printf 'collect_phase2_rewards_provider_context: provider_entity_liveness missing explicit evidence input; gate remains closed\n' >&2
  fi

  if [[ -n "$provider_side_mismatch_evidence_output_local" ]]; then
    provider_side_mismatch_evidence_output_local="$(rewards_provider_sanitize_signal_line "$provider_side_mismatch_evidence_output_local")"
    provider_side_mismatch=1
    same_token_both_sides_expected=1
  fi

  if [[ -n "$artifact_evidence_output_local" ]]; then
    artifact_evidence_output_local="$(rewards_provider_sanitize_signal_line "$artifact_evidence_output_local")"
    artifact_check=1
  fi

  if [[ -n "$code_path_evidence_output_local" ]]; then
    code_path_evidence_output_local="$(rewards_provider_sanitize_signal_line "$code_path_evidence_output_local")"
    code_path_check=1
  fi

  if [[ -n "$code_path_reconciled_evidence_output_local" ]]; then
    code_path_reconciled_evidence_output_local="$(rewards_provider_sanitize_signal_line "$code_path_reconciled_evidence_output_local")"
  fi

  if [[ "$code_path_check" -eq 1 && -n "$code_path_reconciled_evidence_output_local" ]]; then
    code_path_reconciled=1
  fi

  if [[ "$same_token_both_sides_expected" -eq 0 ]] && rewards_provider_has_same_token_signal "$combined"; then
    same_token_both_sides_expected=1
  fi

  if rewards_provider_has_disproved_theory_signal "$combined"; then
    disproved_theory_expected=1
  fi

  if [[ -n "$disproved_theory_evidence_output_local" ]]; then
    disproved_theory_evidence_output_local="$(rewards_provider_sanitize_signal_line "$disproved_theory_evidence_output_local")"
    disproved_theory_recorded=1
    disproved_theory_expected=1
  fi
  primary_symptom_replay_evidence_output="$primary_symptom_replay_evidence_output_local"
  provider_entity_liveness_evidence_output="$provider_entity_liveness_evidence_output_local"
  db_row_provenance_evidence_output="$db_row_provenance_evidence_output_local"
  provider_api_evidence_output="$provider_api_evidence_output_local"
  provider_side_mismatch_evidence_output="$provider_side_mismatch_evidence_output_local"
  artifact_evidence_output="$artifact_evidence_output_local"
  code_path_evidence_output="$code_path_evidence_output_local"
  code_path_reconciled_evidence_output="$code_path_reconciled_evidence_output_local"
  disproved_theory_evidence_output="$disproved_theory_evidence_output_local"

  if [[ "$db_row_provenance" -eq 0 || "$provider_api_check" -eq 0 || "$artifact_check" -eq 0 || "$code_path_check" -eq 0 ]]; then
    base_evidence_incomplete=1
  fi
  if [[ "$rewards_provider_live_probe_expected" -eq 1 && ( "$primary_symptom_replay" -eq 0 || "$provider_entity_liveness" -eq 0 ) ]]; then
    base_evidence_incomplete=1
  fi
  if [[ "$same_token_both_sides_expected" -eq 1 && ( "$provider_side_mismatch" -eq 0 || "$code_path_reconciled" -eq 0 ) ]]; then
    same_token_evidence_incomplete=1
  fi
  if [[ "$disproved_theory_expected" -eq 1 && "$disproved_theory_recorded" -eq 0 ]]; then
    disproved_theory_incomplete=1
  fi

  if [[ "$base_evidence_incomplete" -eq 1 || "$same_token_evidence_incomplete" -eq 1 || "$disproved_theory_incomplete" -eq 1 ]]; then
    rewards_provider_context_note="explicit or raw provider/artifact/code-path evidence outputs are still incomplete; rewards/provider gate remains closed until those live facts are recorded"
  fi
}
