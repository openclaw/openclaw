#!/usr/bin/env bash

SERVICE_CONTEXT_ENABLED="${SERVICE_CONTEXT_ENABLED:-0}"

_sc_graph_edges_text() {
  local graph_json="$1"
  local service_key="$2"
  local field="$3"

  if ! command -v jq >/dev/null 2>&1; then
    printf '\n'
    return 0
  fi

  printf '%s\n' "$graph_json" | jq -r --arg key "$service_key" --arg field "$field" '
    ((.services // {})[$key][$field] // [])
    | map(
        (.service // "unknown")
        + " ("
        + (.edge_type // "unknown")
        + ", "
        + (.discovery_tier // "unknown")
        + ")"
      )
    | join(", ")
  '
}

_sc_graph_health_edges_text() {
  local graph_json="$1"
  local service_key="$2"
  local field="$3"

  if ! command -v jq >/dev/null 2>&1; then
    printf '\n'
    return 0
  fi

  printf '%s\n' "$graph_json" | jq -r --arg key "$service_key" --arg field "$field" '
    def degraded($status):
      (($status // "") | ascii_downcase) as $s
      | ($s == "degraded" or $s == "critical" or $s == "down" or $s == "missing" or $s == "failing");
    ((.services // {})[$key][$field] // [])
    | map(select(degraded(.health_status)))
    | map(
        (.service // "unknown")
        + " ("
        + (.health_status // "unknown")
        + (if (.health_reason // "") != "" then ", " + .health_reason else "" end)
        + ")"
      )
    | join(", ")
  '
}

_sc_graph_cascade_text() {
  local graph_json="$1"
  local service_key="$2"

  if ! command -v jq >/dev/null 2>&1; then
    printf '\n'
    return 0
  fi

  printf '%s\n' "$graph_json" | jq -r --arg key "$service_key" '
    ((.services // {})[$key].depended_by // [])
    | map(select(.cascade_candidate == true))
    | map(.service // "unknown")
    | join(", ")
  '
}

assemble_service_context() {
  [[ "${SERVICE_CONTEXT_ENABLED:-0}" == "1" ]] || return 0

  local cluster="$1"
  local namespace="$2"
  local service="$3"
  local service_key="${namespace}/${service}"

  local out
  out="=== SERVICE CONTEXT: ${service} (${namespace}) ==="

  if declare -f load_service_overlay >/dev/null 2>&1 && declare -f format_overlay_context >/dev/null 2>&1; then
    local overlay
    overlay="$(load_service_overlay "$cluster" "$namespace" "$service")"
    if [[ -n "$overlay" ]]; then
      out+=$'\n'
      out+="$(printf '%s\n' "$overlay" | format_overlay_context)"
    fi
  fi

  if declare -f read_service_graph >/dev/null 2>&1; then
    local graph deps depby degraded_deps degraded_depby cascades
    graph="$(read_service_graph)"

    deps="$(_sc_graph_edges_text "$graph" "$service_key" "depends_on")"
    depby="$(_sc_graph_edges_text "$graph" "$service_key" "depended_by")"
    degraded_deps="$(_sc_graph_health_edges_text "$graph" "$service_key" "depends_on")"
    degraded_depby="$(_sc_graph_health_edges_text "$graph" "$service_key" "depended_by")"
    cascades="$(_sc_graph_cascade_text "$graph" "$service_key")"

    if [[ -n "$deps" ]]; then
      out+=$'\n'
      out+="Dependencies: ${deps}"
    fi
    if [[ -n "$depby" ]]; then
      out+=$'\n'
      out+="Depended by: ${depby}"
    fi
    if [[ -n "$degraded_deps" ]]; then
      out+=$'\n'
      out+="Degraded dependencies: ${degraded_deps}"
    fi
    if [[ -n "$degraded_depby" ]]; then
      out+=$'\n'
      out+="Degraded dependents: ${degraded_depby}"
    fi
    if [[ -n "$cascades" ]]; then
      out+=$'\n'
      out+="Likely cascades: ${cascades}"
    fi
  fi

  if declare -f memory_lookup_broad >/dev/null 2>&1 && declare -f format_memory_context >/dev/null 2>&1; then
    local cards
    cards="$(memory_lookup_broad "$cluster" "$namespace" "$service")"
    out+=$'\n\n'
    out+="$(printf '%s\n' "$cards" | format_memory_context)"
  fi

  printf '%s\n' "$out"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
