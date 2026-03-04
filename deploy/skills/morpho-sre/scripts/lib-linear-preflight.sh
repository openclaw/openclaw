#!/usr/bin/env bash

LINEAR_PREFLIGHT_RETRY_SECONDS="${LINEAR_PREFLIGHT_RETRY_SECONDS:-300}"
LINEAR_PREFLIGHT_TEAM_NAME="${LINEAR_PREFLIGHT_TEAM_NAME:-Platform}"
LINEAR_PREFLIGHT_PROJECT_NAME="${LINEAR_PREFLIGHT_PROJECT_NAME:-[PLATFORM] Backlog}"
LINEAR_PREFLIGHT_ASSIGNEE_NAME="${LINEAR_ASSIGNEE:-florian}"
LINEAR_PREFLIGHT_REQUIRED_LABELS="${LINEAR_PREFLIGHT_REQUIRED_LABELS:-Bug|Monitoring}"
LINEAR_PREFLIGHT_OPTIONAL_LABELS="${LINEAR_PREFLIGHT_OPTIONAL_LABELS:-ai-ready|Security|Alerting|Devops|Technical debt|Improvement}"

LINEAR_AVAILABLE="${LINEAR_AVAILABLE:-unknown}"
LINEAR_PREFLIGHT_CACHE_READY="${LINEAR_PREFLIGHT_CACHE_READY:-0}"
LINEAR_PREFLIGHT_LAST_ATTEMPT_TS="${LINEAR_PREFLIGHT_LAST_ATTEMPT_TS:-0}"
LINEAR_PREFLIGHT_WARNINGS="${LINEAR_PREFLIGHT_WARNINGS:-}"
LINEAR_PREFLIGHT_LAST_ERROR="${LINEAR_PREFLIGHT_LAST_ERROR:-}"

linear_preflight_reset_cache() {
  LINEAR_AVAILABLE="unknown"
  LINEAR_PREFLIGHT_CACHE_READY="0"
  LINEAR_PREFLIGHT_LAST_ATTEMPT_TS="0"
  LINEAR_PREFLIGHT_WARNINGS=""
  LINEAR_PREFLIGHT_LAST_ERROR=""

  LINEAR_PREFLIGHT_TEAM_ID=""
  LINEAR_PREFLIGHT_PROJECT_ID=""
  LINEAR_PREFLIGHT_ASSIGNEE_ID=""
  LINEAR_PREFLIGHT_REQUIRED_LABEL_IDS=""
  LINEAR_PREFLIGHT_OPTIONAL_LABEL_IDS=""
}

_linear_preflight_now() {
  date +%s
}

_linear_preflight_lookup() {
  local entity_type="$1"
  local entity_name="$2"

  if declare -F linear_lookup >/dev/null 2>&1; then
    linear_lookup "$entity_type" "$entity_name"
    return $?
  fi

  if [[ -n "${LINEAR_LOOKUP_CMD:-}" ]] && command -v "$LINEAR_LOOKUP_CMD" >/dev/null 2>&1; then
    "$LINEAR_LOOKUP_CMD" "$entity_type" "$entity_name"
    return $?
  fi

  return 127
}

_linear_preflight_split_pipe() {
  local raw="${1:-}"
  printf '%s\n' "$raw" | tr '|' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | awk 'NF > 0 { print }'
}

_linear_preflight_add_warning() {
  local msg="$1"
  if [[ -z "$LINEAR_PREFLIGHT_WARNINGS" ]]; then
    LINEAR_PREFLIGHT_WARNINGS="$msg"
  else
    LINEAR_PREFLIGHT_WARNINGS+=$'\n'
    LINEAR_PREFLIGHT_WARNINGS+="$msg"
  fi
}

_linear_preflight_resolve_label_ids() {
  local labels="$1"
  local required="$2"
  local ids=""
  local label

  while IFS= read -r label; do
    [[ -z "$label" ]] && continue

    local id rc
    if id="$(_linear_preflight_lookup label "$label" 2>/dev/null)"; then
      rc=0
    else
      rc=$?
    fi

    if [[ "$rc" -eq 0 && -n "$id" ]]; then
      if [[ -z "$ids" ]]; then
        ids="$id"
      else
        ids+="|${id}"
      fi
      continue
    fi

    if [[ "$required" == "required" ]]; then
      LINEAR_PREFLIGHT_LAST_ERROR="missing required label: ${label}"
      return 3
    fi

    _linear_preflight_add_warning "missing optional label: ${label}"
  done < <(_linear_preflight_split_pipe "$labels")

  LINEAR_PREFLIGHT_RESOLVED_LABEL_IDS="$ids"
  return 0
}

linear_preflight_run() {
  local now_ts="${1:-$(_linear_preflight_now)}"

  if [[ "$LINEAR_PREFLIGHT_CACHE_READY" == "1" && "$LINEAR_AVAILABLE" == "true" ]]; then
    return 0
  fi

  if [[ "$LINEAR_AVAILABLE" == "false" ]]; then
    local elapsed=$((now_ts - LINEAR_PREFLIGHT_LAST_ATTEMPT_TS))
    if [[ "$elapsed" -lt "$LINEAR_PREFLIGHT_RETRY_SECONDS" ]]; then
      return 0
    fi
  fi

  LINEAR_PREFLIGHT_LAST_ATTEMPT_TS="$now_ts"
  LINEAR_PREFLIGHT_LAST_ERROR=""
  LINEAR_PREFLIGHT_WARNINGS=""

  local rc=0
  local out=""

  if [[ -n "${LINEAR_TEAM_ID:-}" ]]; then
    LINEAR_PREFLIGHT_TEAM_ID="$LINEAR_TEAM_ID"
  else
    if out="$(_linear_preflight_lookup team "$LINEAR_PREFLIGHT_TEAM_NAME" 2>/dev/null)"; then
      rc=0
    else
      rc=$?
    fi
    if [[ "$rc" -ne 0 || -z "$out" ]]; then
      LINEAR_AVAILABLE="false"
      LINEAR_PREFLIGHT_CACHE_READY="0"
      LINEAR_PREFLIGHT_LAST_ERROR="missing required team: ${LINEAR_PREFLIGHT_TEAM_NAME}"
      return 0
    fi
    LINEAR_PREFLIGHT_TEAM_ID="$out"
  fi

  if out="$(_linear_preflight_lookup project "$LINEAR_PREFLIGHT_PROJECT_NAME" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  if [[ "$rc" -ne 0 || -z "$out" ]]; then
    LINEAR_AVAILABLE="false"
    LINEAR_PREFLIGHT_CACHE_READY="0"
    LINEAR_PREFLIGHT_LAST_ERROR="missing required project: ${LINEAR_PREFLIGHT_PROJECT_NAME}"
    return 0
  fi
  LINEAR_PREFLIGHT_PROJECT_ID="$out"

  if out="$(_linear_preflight_lookup user "$LINEAR_PREFLIGHT_ASSIGNEE_NAME" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi
  if [[ "$rc" -ne 0 || -z "$out" ]]; then
    LINEAR_AVAILABLE="false"
    LINEAR_PREFLIGHT_CACHE_READY="0"
    LINEAR_PREFLIGHT_LAST_ERROR="missing required assignee: ${LINEAR_PREFLIGHT_ASSIGNEE_NAME}"
    return 0
  fi
  LINEAR_PREFLIGHT_ASSIGNEE_ID="$out"

  LINEAR_PREFLIGHT_RESOLVED_LABEL_IDS=""
  if _linear_preflight_resolve_label_ids "$LINEAR_PREFLIGHT_REQUIRED_LABELS" required; then
    rc=0
  else
    rc=$?
  fi
  out="$LINEAR_PREFLIGHT_RESOLVED_LABEL_IDS"
  if [[ "$rc" -ne 0 ]]; then
    LINEAR_AVAILABLE="false"
    LINEAR_PREFLIGHT_CACHE_READY="0"
    [[ -z "$LINEAR_PREFLIGHT_LAST_ERROR" ]] && LINEAR_PREFLIGHT_LAST_ERROR="required label lookup failed"
    return 0
  fi
  LINEAR_PREFLIGHT_REQUIRED_LABEL_IDS="$out"

  LINEAR_PREFLIGHT_RESOLVED_LABEL_IDS=""
  if _linear_preflight_resolve_label_ids "$LINEAR_PREFLIGHT_OPTIONAL_LABELS" optional; then
    out="$LINEAR_PREFLIGHT_RESOLVED_LABEL_IDS"
  else
    out=""
  fi
  LINEAR_PREFLIGHT_OPTIONAL_LABEL_IDS="$out"

  LINEAR_AVAILABLE="true"
  LINEAR_PREFLIGHT_CACHE_READY="1"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  linear_preflight_run
  printf 'LINEAR_AVAILABLE=%s\n' "$LINEAR_AVAILABLE"
fi
