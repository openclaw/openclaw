#!/usr/bin/env bash

linear_ticket_reservation_is_stale() {
  local reservation="${1:-}"
  local now_ts="${2:-$(date +%s)}"
  local ttl="${3:-120}"
  [[ "$reservation" == pending:* ]] || return 1
  local ts="${reservation#pending:}"
  [[ "$ts" =~ ^[0-9]+$ ]] || return 0
  [[ $((now_ts - ts)) -gt "$ttl" ]]
}

linear_ticket_should_create_for_severity() {
  local severity="${1:-}"
  local severity_lc
  severity_lc="$(printf '%s' "$severity" | tr '[:upper:]' '[:lower:]')"
  case "$severity_lc" in
    medium|high|critical) return 0 ;;
    *) return 1 ;;
  esac
}

_linear_ticket_json_get() {
  local json="${1:-}"
  local jq_expr="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$json" | jq -r "$jq_expr" 2>/dev/null || true
    return 0
  fi
  printf '\n'
}

_linear_ticket_ctx_get() {
  local ctx="${1:-}"
  local key="$2"
  printf '%s\n' "$ctx" | tr ';' '\n' | awk -F'=' -v k="$key" '$1==k {print substr($0, index($0, "=")+1); exit}'
}

_linear_ticket_field() {
  local row="${1:-}"
  local index="$2"
  printf '%s\n' "$row" | awk -F'\t' -v idx="$index" 'NR==1 {print $idx}'
}

build_ticket_description() {
  local rca_output="${1:-}"
  local incident_context="${2:-}"

  local incident_id namespace category services summary impact root_cause evidence remediation
  incident_id="$(_linear_ticket_ctx_get "$incident_context" incident_id)"
  namespace="$(_linear_ticket_ctx_get "$incident_context" namespace)"
  category="$(_linear_ticket_ctx_get "$incident_context" category)"
  services="$(_linear_ticket_ctx_get "$incident_context" services)"

  summary="$(_linear_ticket_json_get "$rca_output" '.summary // .brief_description // empty')"
  impact="$(_linear_ticket_json_get "$rca_output" '.blast_radius // .impact // empty')"
  root_cause="$(_linear_ticket_json_get "$rca_output" '.root_cause // .top_hypothesis.description // empty')"
  evidence="$(_linear_ticket_json_get "$rca_output" '(.supporting_evidence // .top_hypothesis.evidence_keys // []) | if type=="array" then join(", ") else tostring end')"
  remediation="$(_linear_ticket_json_get "$rca_output" '.remediation // .recommended_steps // empty')"

  [[ -z "$summary" ]] && summary="[NEEDS REVIEW]"
  [[ -z "$impact" ]] && impact="[NEEDS REVIEW]"
  [[ -z "$root_cause" ]] && root_cause="[NEEDS REVIEW]"
  [[ -z "$evidence" ]] && evidence="[NEEDS REVIEW]"
  [[ -z "$remediation" ]] && remediation="[NEEDS REVIEW]"

  cat <<EOF_MD
## Incident Metadata
- Incident ID: ${incident_id:-[NEEDS REVIEW]}
- Namespace: ${namespace:-[NEEDS REVIEW]}
- Category: ${category:-[NEEDS REVIEW]}
- Services: ${services:-[NEEDS REVIEW]}

## Summary
${summary}

## Impact
${impact}

## Root Cause Analysis
${root_cause}

## Supporting Evidence
${evidence}

## Remediation Plan
${remediation}

## Resolution Context
[NEEDS REVIEW]
EOF_MD
}

detect_patterns() {
  local _incident_id="${1:-}"
  local category="${2:-}"
  local namespace="${3:-}"
  local services="${4:-}"

  if ! declare -F linear_ticket_api_search_patterns >/dev/null 2>&1; then
    printf '\n'
    return 0
  fi

  local results
  if ! results="$(linear_ticket_api_search_patterns "$category" "$namespace" "$services" 2>/dev/null)"; then
    printf '\n'
    return 0
  fi

  local count
  count="$(printf '%s\n' "$results" | awk 'NF>0 {c++} END {print c+0}')"
  if [[ "$count" -lt 3 ]]; then
    printf '\n'
    return 0
  fi

  local refs
  refs="$(printf '%s\n' "$results" | awk 'NF>0 {print $1}' | paste -sd', ' -)"

  cat <<EOF_MD

## Recurring Pattern
**Frequency:** ${count} similar incidents in last 30 days
**Common signals:** ${category}, ${services:-[NEEDS REVIEW]}
**Previous tickets:** ${refs}
**Recommendation:** prioritize systemic fix and add Technical debt label.
EOF_MD
}

_linear_ticket_trim_versions() {
  local text="${1:-}"
  local max_versions="${2:-3}"
  printf '%s\n' "$text" | awk -v keep="$max_versions" '
    /^### RCA v[0-9]+/ {
      block++
      current = block
    }
    {
      lines[NR] = $0
      block_idx[NR] = current
    }
    END {
      min_block = block - keep + 1
      if (min_block < 1) min_block = 1
      for (i = 1; i <= NR; i++) {
        if (block_idx[i] == 0 || block_idx[i] >= min_block) print lines[i]
      }
    }
  '
}

update_ticket_rca() {
  local ticket_id="${1:-}"
  local new_rca="${2:-}"
  local version="${3:-1}"

  local existing=""
  if declare -F linear_ticket_api_get_description >/dev/null 2>&1; then
    existing="$(linear_ticket_api_get_description "$ticket_id" 2>/dev/null || true)"
  fi

  local block
  block=$'\n\n'
  block+="### RCA v${version}"
  block+=$'\n```json\n'
  block+="$new_rca"
  block+=$'\n```\n'

  local updated="${existing}${block}"
  updated="$(_linear_ticket_trim_versions "$updated" 3)"

  if declare -F linear_ticket_api_update >/dev/null 2>&1; then
    linear_ticket_api_update "$ticket_id" "$updated" >/dev/null
  fi

  printf '%s\n' "$ticket_id"
}

create_or_update_ticket() {
  local incident_id="${1:-}"
  local rca_output="${2:-}"
  local state_row="${3:-}"
  local now_ts="${4:-$(date +%s)}"

  local severity
  severity="$(_linear_ticket_json_get "$rca_output" '.severity // .severity_level // "medium"')"
  [[ -z "$severity" ]] && severity="medium"

  if ! linear_ticket_should_create_for_severity "$severity"; then
    printf 'skipped\tseverity\n'
    return 0
  fi

  local namespace category version linear_ticket_id reservation services
  namespace="$(_linear_ticket_field "$state_row" 2)"
  category="$(_linear_ticket_field "$state_row" 3)"
  version="$(_linear_ticket_field "$state_row" 7)"
  linear_ticket_id="$(_linear_ticket_field "$state_row" 10)"
  services="$(_linear_ticket_field "$state_row" 12)"
  reservation="$(_linear_ticket_field "$state_row" 18)"

  [[ -z "$version" ]] && version="1"

  if [[ -n "$linear_ticket_id" ]]; then
    update_ticket_rca "$linear_ticket_id" "$rca_output" "$version" >/dev/null
    printf '%s\n' "$linear_ticket_id"
    return 0
  fi

  if [[ -n "$reservation" ]] && ! linear_ticket_reservation_is_stale "$reservation" "$now_ts"; then
    printf 'reserved\n'
    return 0
  fi

  local found_ticket=""
  if declare -F linear_ticket_api_search_by_incident >/dev/null 2>&1; then
    found_ticket="$(linear_ticket_api_search_by_incident "$incident_id" 2>/dev/null || true)"
  fi

  local description context patterns labels
  context="incident_id=${incident_id};namespace=${namespace};category=${category};services=${services}"
  description="$(build_ticket_description "$rca_output" "$context")"
  patterns="$(detect_patterns "$incident_id" "$category" "$namespace" "$services")"
  labels="Bug|Monitoring"
  if [[ -n "$patterns" ]]; then
    description+="$patterns"
    labels+="|Technical debt|Improvement"
  fi

  local ticket_id
  if [[ -n "$found_ticket" ]]; then
    ticket_id="$found_ticket"
    update_ticket_rca "$ticket_id" "$rca_output" "$version" >/dev/null
    printf '%s\n' "$ticket_id"
    return 0
  fi

  if declare -F linear_ticket_api_create >/dev/null 2>&1; then
    local title
    title="[Incident] $(printf '%s' "$severity" | tr '[:lower:]' '[:upper:]'): ${category:-unknown} ${namespace:-unknown}"
    ticket_id="$(linear_ticket_api_create "$title" "$description" "$labels")"
    printf '%s\n' "$ticket_id"
    return 0
  fi

  printf 'error\tno_linear_provider\n' >&2
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
