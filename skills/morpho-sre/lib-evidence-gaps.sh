#!/usr/bin/env bash

evidence_gap_manifest_dir() {
  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -d "${script_dir}/evidence-manifests" ]]; then
    printf '%s\n' "${script_dir}/evidence-manifests"
    return 0
  fi
  if [[ -n "${OPENCLAW_SRE_HELM_REPO_DIR:-}" ]]; then
    printf '%s\n' "${OPENCLAW_SRE_HELM_REPO_DIR%/}/../openclaw-sre/skills/morpho-sre/evidence-manifests"
    return 0
  fi
  printf '%s\n' "${script_dir}/evidence-manifests"
}

evidence_gap_manifest_path() {
  local category="${1:-unknown}"
  printf '%s/%s.yaml\n' "$(evidence_gap_manifest_dir)" "$category"
}

_evidence_gap_section_keys() {
  local manifest_file="$1"
  local section="$2"
  awk -v section="$section" '
    $0 ~ ("^" section ":") { active=1; next }
    active && $0 ~ /^[A-Za-z0-9_]+:/ { active=0 }
    active && $0 ~ /^[[:space:]]*-[[:space:]]*/ {
      sub(/^[[:space:]]*-[[:space:]]*/, "", $0)
      gsub(/[[:space:]]+$/, "", $0)
      if ($0 != "") print $0
    }
  ' "$manifest_file"
}

_evidence_gap_value_present() {
  local value="${1:-}"
  local normalized
  normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [[ -n "$normalized" ]] || return 1
  case "$normalized" in
    0 | 0.0 | false | no | none | null | unknown | missing | skipped | disabled | empty_output | script_missing)
      return 1
      ;;
  esac
  return 0
}

_evidence_gap_lookup_value() {
  local source_file="$1"
  local lookup_key="$2"
  awk -F'=' -v lookup_key="$lookup_key" '
    $1 == lookup_key {
      print substr($0, length($1) + 2)
      found=1
      exit
    }
    END {
      if (!found) print ""
    }
  ' "$source_file"
}

evidence_gaps_assess() {
  local category="${1:-unknown}"
  local source_file="${2:-/dev/stdin}"
  local manifest_file critical_keys optional_keys
  local single_vault_graphql_keys single_vault_graphql_optional_keys single_vault_graphql_mode
  local rewards_provider_keys rewards_provider_optional_keys rewards_provider_live_probe_keys
  local rewards_provider_same_token_keys rewards_provider_reversal_keys
  local rewards_provider_mode rewards_provider_live_probe_required rewards_provider_same_token_required rewards_provider_reversal_required
  local total_keys=0 present_keys=0 missing_critical_count=0 missing_optional_count=0
  local confidence_penalty=0 confidence_cap=60 key value
  local missing_critical_json missing_optional_json completeness_percent
  local missing_critical_lines="" missing_optional_lines=""

  manifest_file="$(evidence_gap_manifest_path "$category")"
  if [[ ! -f "$manifest_file" ]]; then
    printf '{"category":"%s","completeness_percent":0,"missing_critical":["manifest_missing"],"missing_optional":[],"confidence_penalty":40}\n' "$category"
    return 0
  fi

  critical_keys="$(_evidence_gap_section_keys "$manifest_file" critical)"
  optional_keys="$(_evidence_gap_section_keys "$manifest_file" optional)"
  single_vault_graphql_mode="$(_evidence_gap_lookup_value "$source_file" "single_vault_graphql_mode")"
  if [[ "$category" == "data_issue" ]] && _evidence_gap_value_present "${single_vault_graphql_mode:-}"; then
    single_vault_graphql_keys="$(_evidence_gap_section_keys "$manifest_file" single_vault_graphql_critical)"
    critical_keys="$(
      printf '%s\n%s\n' "$critical_keys" "$single_vault_graphql_keys" \
        | awk 'NF > 0 && !seen[$0]++ { print }'
    )"
    single_vault_graphql_optional_keys="$(_evidence_gap_section_keys "$manifest_file" single_vault_graphql_optional)"
    optional_keys="$(
      printf '%s\n%s\n' "$optional_keys" "$single_vault_graphql_optional_keys" \
        | awk 'NF > 0 && !seen[$0]++ { print }'
    )"
  fi
  rewards_provider_mode="$(_evidence_gap_lookup_value "$source_file" "rewards_provider_mode")"
  if [[ "$category" == "data_issue" ]] && _evidence_gap_value_present "${rewards_provider_mode:-}"; then
    rewards_provider_keys="$(_evidence_gap_section_keys "$manifest_file" rewards_provider_critical)"
    critical_keys="$(
      printf '%s\n%s\n' "$critical_keys" "$rewards_provider_keys" \
        | awk 'NF > 0 && !seen[$0]++ { print }'
    )"
    rewards_provider_optional_keys="$(_evidence_gap_section_keys "$manifest_file" rewards_provider_optional)"
    optional_keys="$(
      printf '%s\n%s\n' "$optional_keys" "$rewards_provider_optional_keys" \
        | awk 'NF > 0 && !seen[$0]++ { print }'
    )"
    rewards_provider_live_probe_required="$(_evidence_gap_lookup_value "$source_file" "rewards_provider_live_probe_expected")"
    if _evidence_gap_value_present "${rewards_provider_live_probe_required:-}"; then
      rewards_provider_live_probe_keys="$(_evidence_gap_section_keys "$manifest_file" rewards_provider_live_probe_critical)"
      critical_keys="$(
        printf '%s\n%s\n' "$critical_keys" "$rewards_provider_live_probe_keys" \
          | awk 'NF > 0 && !seen[$0]++ { print }'
      )"
    fi
    rewards_provider_same_token_required="$(_evidence_gap_lookup_value "$source_file" "same_token_both_sides_expected")"
    if _evidence_gap_value_present "${rewards_provider_same_token_required:-}"; then
      rewards_provider_same_token_keys="$(_evidence_gap_section_keys "$manifest_file" rewards_provider_same_token_critical)"
      critical_keys="$(
        printf '%s\n%s\n' "$critical_keys" "$rewards_provider_same_token_keys" \
          | awk 'NF > 0 && !seen[$0]++ { print }'
      )"
    fi
    rewards_provider_reversal_required="$(_evidence_gap_lookup_value "$source_file" "disproved_theory_expected")"
    if _evidence_gap_value_present "${rewards_provider_reversal_required:-}"; then
      rewards_provider_reversal_keys="$(_evidence_gap_section_keys "$manifest_file" rewards_provider_reversal_critical)"
      critical_keys="$(
        printf '%s\n%s\n' "$critical_keys" "$rewards_provider_reversal_keys" \
          | awk 'NF > 0 && !seen[$0]++ { print }'
      )"
    fi
  fi

  optional_keys="$(
    awk 'NR == FNR { if (NF > 0) seen[$0] = 1; next } NF > 0 && !seen[$0]++ { print }' \
      <(printf '%s\n' "$critical_keys") \
      <(printf '%s\n' "$optional_keys")
  )"

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    total_keys=$((total_keys + 1))
    value="$(_evidence_gap_lookup_value "$source_file" "$key")"
    if _evidence_gap_value_present "${value:-}"; then
      present_keys=$((present_keys + 1))
    else
      missing_critical_count=$((missing_critical_count + 1))
      missing_critical_lines="${missing_critical_lines}${key}"$'\n'
    fi
  done <<<"$critical_keys"

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    total_keys=$((total_keys + 1))
    value="$(_evidence_gap_lookup_value "$source_file" "$key")"
    if _evidence_gap_value_present "${value:-}"; then
      present_keys=$((present_keys + 1))
    else
      missing_optional_count=$((missing_optional_count + 1))
      missing_optional_lines="${missing_optional_lines}${key}"$'\n'
    fi
  done <<<"$optional_keys"

  missing_critical_json="$(printf '%s' "$missing_critical_lines" | awk 'NF > 0 { print }' | jq -R . | jq -s .)"
  missing_optional_json="$(printf '%s' "$missing_optional_lines" | awk 'NF > 0 { print }' | jq -R . | jq -s .)"

  if _evidence_gap_value_present "$(_evidence_gap_lookup_value "$source_file" "primary_reported_symptom")"; then
    if ! _evidence_gap_value_present "$(_evidence_gap_lookup_value "$source_file" "explains_primary_symptom")"; then
      if missing_critical_json_next="$(printf '%s\n' "$missing_critical_json" | jq -c '. + ["primary_symptom_unexplained"]' 2>/dev/null)"; then
        missing_critical_json="$missing_critical_json_next"
        missing_critical_count=$((missing_critical_count + 1))
        total_keys=$((total_keys + 1))
        # 78 = default 60 cap + one 18-point critical-gap unit for the synthetic anchor check.
        confidence_cap=78
      elif [[ "${DEBUG:-0}" == "1" ]]; then
        printf 'evidence_gaps_assess: primary_symptom_unexplained jq append failed\n' >&2
      fi
    fi
  fi

  if [[ "$total_keys" -gt 0 ]]; then
    completeness_percent="$(awk -v present="$present_keys" -v total="$total_keys" 'BEGIN { printf "%.1f", (present * 100.0) / total }')"
  else
    completeness_percent="100.0"
  fi

  confidence_penalty=$((missing_critical_count * 18 + missing_optional_count * 5))
  if [[ "$confidence_penalty" -gt "$confidence_cap" ]]; then
    confidence_penalty="$confidence_cap"
  fi

  jq -cn \
    --arg category "$category" \
    --argjson completeness_percent "$completeness_percent" \
    --argjson missing_critical "$missing_critical_json" \
    --argjson missing_optional "$missing_optional_json" \
    --argjson confidence_penalty "$confidence_penalty" \
    '{
      category: $category,
      completeness_percent: $completeness_percent,
      missing_critical: $missing_critical,
      missing_optional: $missing_optional,
      confidence_penalty: $confidence_penalty
    }'
}
