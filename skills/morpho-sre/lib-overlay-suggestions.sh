#!/usr/bin/env bash

OVERLAY_SUGGESTIONS_MAX_ENTRIES="${OVERLAY_SUGGESTIONS_MAX_ENTRIES:-50}"
OVERLAY_SUGGESTIONS_EXPIRY_DAYS="${OVERLAY_SUGGESTIONS_EXPIRY_DAYS:-30}"

_overlay_suggestions_file() {
  if [[ -n "${OVERLAY_SUGGESTIONS_FILE:-}" ]]; then
    printf '%s\n' "$OVERLAY_SUGGESTIONS_FILE"
    return 0
  fi
  local state_dir
  state_dir="${INCIDENT_STATE_DIR:-/tmp/openclaw-state}"
  printf '%s\n' "${state_dir%/}/pending-overlay-suggestions.jsonl"
}

_overlay_now_s() {
  date +%s
}

_overlay_now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

_overlay_with_lock() {
  local lock_file="$1"
  shift
  mkdir -p "${lock_file%/*}"

  if command -v flock >/dev/null 2>&1; then
    local fd
    exec {fd}>"$lock_file"
    flock -x "$fd"
    local rc=0
    if "$@"; then
      rc=0
    else
      rc=$?
    fi
    flock -u "$fd" >/dev/null 2>&1 || true
    eval "exec ${fd}>&-"
    return "$rc"
  fi

  "$@"
}

_overlay_sanitize_payload() {
  local payload="${1:-}"
  if declare -F _rca_prompt_scrub >/dev/null 2>&1; then
    payload="$(_rca_prompt_scrub "$payload")"
  fi
  if declare -F _strip_instruction_tokens >/dev/null 2>&1; then
    payload="$(_strip_instruction_tokens "$payload")"
  fi
  printf '%s\n' "$payload"
}

_overlay_read_jsonl_array() {
  local file="$1"
  local arr line obj
  arr='[]'

  if [[ ! -f "$file" ]]; then
    printf '%s\n' "$arr"
    return 0
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    obj="$(printf '%s\n' "$line" | jq -c . 2>/dev/null || true)"
    if [[ -z "$obj" || "$obj" == "null" ]]; then
      continue
    fi
    arr="$(jq -cn --argjson arr "$arr" --argjson obj "$obj" '$arr + [$obj]')"
  done <"$file"

  printf '%s\n' "$arr"
}

_overlay_prune_array() {
  local arr="$1"
  local now_s cutoff cap
  now_s="$(_overlay_now_s)"
  cutoff="$((now_s - OVERLAY_SUGGESTIONS_EXPIRY_DAYS * 86400))"
  cap="${OVERLAY_SUGGESTIONS_MAX_ENTRIES:-50}"
  [[ "$cap" =~ ^[0-9]+$ ]] || cap=50

  jq -cn \
    --argjson arr "$arr" \
    --argjson cutoff "$cutoff" \
    --argjson cap "$cap" \
    '
      $arr
      | map(
          . as $row
          | (
              $row.timestamp_epoch
              // (
                ($row.timestamp // "")
                | (try fromdateiso8601 catch 0)
              )
            ) as $ts
          | select(($ts | tonumber? // 0) >= $cutoff)
          | .timestamp_epoch = ($ts | tonumber? // 0)
        )
      | sort_by(.timestamp_epoch)
      | reverse
      | .[:$cap]
    '
}

_overlay_write_jsonl_array() {
  local file="$1"
  local arr="$2"
  local tmp

  mkdir -p "${file%/*}"
  tmp="${file}.tmp.$$"
  printf '%s\n' "$arr" | jq -c '.[]' >"$tmp"
  mv -f "$tmp" "$file"
}

_overlay_load_pruned_locked() {
  local file arr
  file="$(_overlay_suggestions_file)"
  arr="$(_overlay_read_jsonl_array "$file")"
  arr="$(_overlay_prune_array "$arr")"
  _overlay_write_jsonl_array "$file" "$arr"
  printf '%s\n' "$arr"
}

_suggestion_write_locked() {
  local item="$1"
  local file arr key
  file="$(_overlay_suggestions_file)"
  arr="$(_overlay_load_pruned_locked)"
  key="$(printf '%s\n' "$item" | jq -r '.suggestion_key // ""')"

  arr="$(jq -cn \
    --argjson arr "$arr" \
    --argjson item "$item" \
    --arg key "$key" \
    '
      if any($arr[]?; .suggestion_key == $key) then
        ($arr | map(if .suggestion_key == $key then $item else . end))
      else
        ($arr + [$item])
      end
    ')"

  arr="$(_overlay_prune_array "$arr")"
  _overlay_write_jsonl_array "$file" "$arr"
  printf '%s\n' "$item"
}

suggestion_write() {
  if ! command -v jq >/dev/null 2>&1; then
    return 1
  fi

  local raw="${1:-}"
  local sanitized item key now_s now_iso file
  [[ -n "$raw" ]] || return 1

  sanitized="$(_overlay_sanitize_payload "$raw")"
  item="$(printf '%s\n' "$sanitized" | jq -c . 2>/dev/null || true)"
  [[ -n "$item" ]] || return 1

  key="$(printf '%s\n' "$item" | jq -r '.suggestion_key // ""')"
  [[ -n "$key" ]] || return 1

  now_s="$(_overlay_now_s)"
  now_iso="$(_overlay_now_iso)"

  item="$(printf '%s\n' "$item" | jq -c --arg ts "$now_iso" --argjson tse "$now_s" '
    .timestamp = $ts
    | .timestamp_epoch = $tse
    | .status = (.status // "pending")
  ')"

  file="$(_overlay_suggestions_file)"
  _overlay_with_lock "${file}.lock" _suggestion_write_locked "$item"
}

_suggestion_list_pending_locked() {
  local arr
  arr="$(_overlay_load_pruned_locked)"
  printf '%s\n' "$arr" | jq -c '.[] | select((.status // "pending") == "pending")'
}

suggestion_list_pending() {
  if ! command -v jq >/dev/null 2>&1; then
    return 1
  fi
  local file
  file="$(_overlay_suggestions_file)"
  _overlay_with_lock "${file}.lock" _suggestion_list_pending_locked
}

_suggestion_set_status_locked() {
  local key="$1"
  local status="$2"
  local file arr now_s now_iso found
  file="$(_overlay_suggestions_file)"
  arr="$(_overlay_load_pruned_locked)"

  found="$(printf '%s\n' "$arr" | jq -r --arg key "$key" 'any(.[]?; .suggestion_key == $key)')"
  if [[ "$found" != "true" ]]; then
    return 1
  fi

  now_s="$(_overlay_now_s)"
  now_iso="$(_overlay_now_iso)"
  arr="$(printf '%s\n' "$arr" | jq -c \
    --arg key "$key" \
    --arg status "$status" \
    --arg ts "$now_iso" \
    --argjson tse "$now_s" '
      map(
        if .suggestion_key == $key then
          .status = $status
          | .status_updated_at = $ts
          | .status_updated_epoch = $tse
        else
          .
        end
      )
    ')"
  _overlay_write_jsonl_array "$file" "$arr"
  printf '%s\n' "$arr" | jq -c --arg key "$key" '.[] | select(.suggestion_key == $key)'
}

suggestion_set_status() {
  if ! command -v jq >/dev/null 2>&1; then
    return 1
  fi
  local key="${1:-}"
  local status="${2:-}"
  local file

  [[ -n "$key" ]] || return 1
  case "$status" in
    pending | approved | quarantined | rejected) ;;
    *) return 1 ;;
  esac

  file="$(_overlay_suggestions_file)"
  _overlay_with_lock "${file}.lock" _suggestion_set_status_locked "$key" "$status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
