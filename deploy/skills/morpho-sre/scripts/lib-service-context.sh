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
    local graph deps depby
    graph="$(read_service_graph)"

    deps="$(_sc_graph_edges_text "$graph" "$service_key" "depends_on")"
    depby="$(_sc_graph_edges_text "$graph" "$service_key" "depended_by")"

    if [[ -n "$deps" ]]; then
      out+=$'\n'
      out+="Dependencies: ${deps}"
    fi
    if [[ -n "$depby" ]]; then
      out+=$'\n'
      out+="Depended by: ${depby}"
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
