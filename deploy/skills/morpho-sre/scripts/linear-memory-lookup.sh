#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/lib-linear-preflight.sh" ]]; then
  # shellcheck source=lib-linear-preflight.sh
  source "${SCRIPT_DIR}/lib-linear-preflight.sh"
fi

LINEAR_MEMORY_TIMEOUT_SECONDS="${LINEAR_MEMORY_TIMEOUT_SECONDS:-5}"
LINEAR_MEMORY_DEFAULT_LIMIT="${LINEAR_MEMORY_DEFAULT_LIMIT:-5}"

_linear_memory_provider_available() {
  if declare -F linear_memory_provider >/dev/null 2>&1; then
    return 0
  fi
  [[ -n "${LINEAR_MEMORY_PROVIDER_SCRIPT:-}" && -x "${LINEAR_MEMORY_PROVIDER_SCRIPT}" ]]
}

_linear_memory_run_provider() {
  local query="$1"
  local limit="$2"

  if declare -F linear_memory_provider >/dev/null 2>&1; then
    linear_memory_provider "$query" "$limit"
    return $?
  fi

  "$LINEAR_MEMORY_PROVIDER_SCRIPT" "$query" "$limit"
}

linear_memory_lookup() {
  local query="${1:-}"
  local limit="${2:-$LINEAR_MEMORY_DEFAULT_LIMIT}"

  if [[ "${LINEAR_MEMORY_RUN_PREFLIGHT:-0}" == "1" ]] && declare -F linear_preflight_run >/dev/null 2>&1; then
    linear_preflight_run >/dev/null 2>&1 || true
  fi

  if [[ "${LINEAR_AVAILABLE:-true}" == "false" ]]; then
    printf 'status\tskipped\tlinear_unavailable\n'
    return 0
  fi

  if ! _linear_memory_provider_available; then
    printf 'status\tskipped\tprovider_unavailable\n'
    return 0
  fi

  local output=""
  local rc=0

  if declare -F linear_memory_provider >/dev/null 2>&1; then
    if output="$(_linear_memory_run_provider "$query" "$limit" 2>/dev/null)"; then
      rc=0
    else
      rc=$?
    fi
  elif command -v timeout >/dev/null 2>&1; then
    if output="$(timeout "${LINEAR_MEMORY_TIMEOUT_SECONDS}s" "$LINEAR_MEMORY_PROVIDER_SCRIPT" "$query" "$limit" 2>/dev/null)"; then
      rc=0
    else
      rc=$?
    fi
  else
    if output="$(_linear_memory_run_provider "$query" "$limit" 2>/dev/null)"; then
      rc=0
    else
      rc=$?
    fi
  fi

  if [[ "$rc" -eq 124 ]]; then
    printf 'status\tskipped\ttimeout\n'
    return 0
  fi

  if [[ "$rc" -ne 0 ]]; then
    printf 'status\tskipped\tprovider_error\n'
    return 0
  fi

  local count
  count="$(printf '%s\n' "$output" | awk 'NF>0 {c++} END {print c+0}')"
  printf 'status\tok\t%s\n' "$count"
  printf 'ticket_id\ttitle\tresolution_context\tdays_ago\n'
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
}

usage() {
  cat <<'USAGE'
linear-memory-lookup.sh --query "text" [--limit 5]
USAGE
}

main() {
  local query=""
  local limit="$LINEAR_MEMORY_DEFAULT_LIMIT"

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --query)
        query="$2"
        shift 2
        ;;
      --limit)
        limit="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        printf 'unknown arg: %s\n' "$1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  linear_memory_lookup "$query" "$limit"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
