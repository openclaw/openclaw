#!/usr/bin/env bash

OUTBOX_MAX_ATTEMPTS="${OUTBOX_MAX_ATTEMPTS:-3}"

outbox_should_attempt() {
  local status="${1:-pending}"
  local attempts="${2:-0}"
  local max_attempts="${3:-$OUTBOX_MAX_ATTEMPTS}"

  case "$status" in
    pending|failed_retryable)
      [[ "$attempts" -lt "$max_attempts" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

outbox_claim_attempt() {
  local target_version="${1:-1}"
  local row_version="${2:-1}"
  local status="${3:-pending}"
  local attempts="${4:-0}"
  local max_attempts="${5:-$OUTBOX_MAX_ATTEMPTS}"

  if [[ "$target_version" != "$row_version" ]]; then
    printf 'stale\t%s\t%s\n' "$status" "$attempts"
    return 0
  fi

  if ! outbox_should_attempt "$status" "$attempts" "$max_attempts"; then
    if [[ "$status" == "failed_retryable" && "$attempts" -ge "$max_attempts" ]]; then
      printf 'terminal\tfailed_terminal\t%s\n' "$attempts"
      return 0
    fi
    printf 'skip\t%s\t%s\n' "$status" "$attempts"
    return 0
  fi

  printf 'claimed\t%s\t%s\n' "$status" "$((attempts + 1))"
}

outbox_finalize() {
  local target_version="${1:-1}"
  local row_version="${2:-1}"
  local status="${3:-pending}"
  local attempts="${4:-0}"
  local call_rc="${5:-1}"
  local max_attempts="${6:-$OUTBOX_MAX_ATTEMPTS}"

  if [[ "$target_version" != "$row_version" ]]; then
    printf 'stale\t%s\t%s\n' "$status" "$attempts"
    return 0
  fi

  if [[ "$call_rc" -eq 0 ]]; then
    printf 'sent\tsent\t%s\n' "$attempts"
    return 0
  fi

  if [[ "$attempts" -ge "$max_attempts" ]]; then
    printf 'failed_terminal\tfailed_terminal\t%s\n' "$attempts"
    return 0
  fi

  printf 'failed_retryable\tfailed_retryable\t%s\n' "$attempts"
}

outbox_should_alert_terminal() {
  local prev_status="${1:-}"
  local next_status="${2:-}"
  [[ "$prev_status" != "failed_terminal" && "$next_status" == "failed_terminal" ]]
}

outbox_run_delivery() {
  local target_version="${1:-1}"
  local row_version="${2:-1}"
  local status="${3:-pending}"
  local attempts="${4:-0}"
  shift 4

  local claim
  claim="$(outbox_claim_attempt "$target_version" "$row_version" "$status" "$attempts")"
  local claim_action claim_status claim_attempts
  claim_action="$(printf '%s\n' "$claim" | awk -F'\t' '{print $1}')"
  claim_status="$(printf '%s\n' "$claim" | awk -F'\t' '{print $2}')"
  claim_attempts="$(printf '%s\n' "$claim" | awk -F'\t' '{print $3}')"

  if [[ "$claim_action" != "claimed" ]]; then
    printf '%s\t%s\t%s\n' "$claim_action" "$claim_status" "$claim_attempts"
    return 0
  fi

  local call_rc=1
  if "$@"; then
    call_rc=0
  fi

  outbox_finalize "$target_version" "$row_version" "$claim_status" "$claim_attempts" "$call_rc"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
