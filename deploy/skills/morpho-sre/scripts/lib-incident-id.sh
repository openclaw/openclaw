#!/usr/bin/env bash

_iid_sanitize_token() {
  local raw="${1:-}"
  [[ -z "$raw" ]] && {
    printf '\n'
    return 0
  }
  printf '%s\n' "$raw" | sed -E 's/[^a-zA-Z0-9_:.-]+/_/g; s/^_+|_+$//g'
}

_iid_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r | awk '{print $1}'
    return 0
  fi
  cksum | awk '{print $1}'
}

_iid_normalize_workloads() {
  local input="${1:-}"
  [[ -z "$input" ]] && {
    printf '\n'
    return 0
  }

  printf '%s\n' "$input" \
    | tr '|, ' '\n\n\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 { print }' \
    | sort -u
}

compute_workload_hash8() {
  local input="${1:-}"
  if [[ "$#" -gt 1 ]]; then
    input="$*"
  fi

  local normalized
  normalized="$(_iid_normalize_workloads "$input")"
  [[ -z "$normalized" ]] && {
    printf 'empty000\n'
    return 0
  }

  printf '%s\n' "$normalized" | _iid_sha256 | cut -c1-8
}

extract_betterstack_id() {
  local context="${1:-}"
  [[ -z "$context" ]] && return 1

  if [[ "$context" =~ bs:([a-zA-Z0-9._:-]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  local from_key
  from_key="$(printf '%s\n' "$context" | grep -Eo 'betterstack[_-]?incident[_-]?id[[:space:]]*[:=][[:space:]]*[a-zA-Z0-9._:-]+' | head -n1 || true)"
  if [[ -n "$from_key" ]]; then
    printf '%s\n' "$from_key" | sed -E 's/.*[:=][[:space:]]*//' 
    return 0
  fi

  local from_url
  from_url="$(printf '%s\n' "$context" | grep -Eo 'incidents/[a-zA-Z0-9._:-]+' | head -n1 || true)"
  if [[ -n "$from_url" ]]; then
    printf '%s\n' "${from_url#incidents/}"
    return 0
  fi

  local from_query
  from_query="$(printf '%s\n' "$context" | grep -Eo 'incident_id=[a-zA-Z0-9._:-]+' | head -n1 || true)"
  if [[ -n "$from_query" ]]; then
    printf '%s\n' "${from_query#incident_id=}"
    return 0
  fi

  return 1
}

generate_incident_id() {
  local source_type="${1:-}"
  case "$source_type" in
    bs|betterstack)
      local betterstack_id="${2:-}"
      local slack_thread_ts="${3:-}"
      local thread_context="${4:-}"

      if [[ -z "$betterstack_id" && -n "$thread_context" ]]; then
        betterstack_id="$(extract_betterstack_id "$thread_context" || true)"
      fi

      betterstack_id="$(_iid_sanitize_token "$betterstack_id")"
      slack_thread_ts="$(_iid_sanitize_token "$slack_thread_ts")"

      if [[ -n "$betterstack_id" ]]; then
        printf 'bs:%s\n' "$betterstack_id"
        return 0
      fi
      if [[ -n "$slack_thread_ts" ]]; then
        printf 'bs:thread:%s\n' "$slack_thread_ts"
        return 0
      fi

      printf 'missing BetterStack id/thread context\n' >&2
      return 1
      ;;

    hb|heartbeat)
      local namespace="${2:-}"
      local category="${3:-unknown}"
      local first_seen_ts="${4:-}"
      local pod_prefixes="${5:-}"

      namespace="$(_iid_sanitize_token "$namespace")"
      category="$(_iid_sanitize_token "$category")"
      [[ -z "$category" ]] && category="unknown"

      if [[ -z "$first_seen_ts" ]]; then
        first_seen_ts="$(date -u +%Y%m%dT%H%M)"
      fi
      first_seen_ts="$(_iid_sanitize_token "$first_seen_ts")"

      local workload_hash8
      workload_hash8="$(compute_workload_hash8 "$pod_prefixes")"

      printf 'hb:%s:%s:%s:%s\n' "$namespace" "$category" "$first_seen_ts" "$workload_hash8"
      ;;

    *)
      printf 'unknown incident source_type: %s\n' "$source_type" >&2
      return 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf '%s\n' "$(generate_incident_id "$@")"
fi
