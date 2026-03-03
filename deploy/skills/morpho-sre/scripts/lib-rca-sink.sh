#!/usr/bin/env bash

_sink_detect_entropy_tokens() {
  local payload="${1:-}"
  printf '%s\n' "$payload" \
    | tr -cs 'A-Za-z0-9+/=._-' '\n' \
    | awk 'length($0) >= 24' \
    | while IFS= read -r token; do
      [[ -z "$token" ]] && continue
      [[ "$token" == *"<redacted"* ]] && continue
      [[ "$token" == *"[redacted:"* ]] && continue

      if [[ "$token" =~ ^[A-Fa-f0-9]{32,}$ ]]; then
        printf '%s\n' "$token"
        continue
      fi

      if [[ "$token" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
        printf '%s\n' "$token"
        continue
      fi

      local len unique ratio
      len="${#token}"
      unique="$(printf '%s' "$token" | fold -w1 | sort -u | wc -l | tr -d '[:space:]')"
      [[ "$unique" =~ ^[0-9]+$ ]] || unique=0
      ratio=$(( unique * 100 / len ))

      if (( len >= 32 && ratio >= 45 )); then
        printf '%s\n' "$token"
      fi
    done \
    | sort -u
}

redact_for_sink() {
  local payload="${1:-}"
  local sink="${2:-unknown}"
  local hits remaining token

  if declare -F _rca_prompt_scrub >/dev/null 2>&1; then
    payload="$(_rca_prompt_scrub "$payload")"
  fi

  if declare -F _strip_instruction_tokens >/dev/null 2>&1; then
    payload="$(_strip_instruction_tokens "$payload")"
  fi

  hits="$(_sink_detect_entropy_tokens "$payload")"
  if [[ -n "$hits" ]]; then
    while IFS= read -r token; do
      [[ -z "$token" ]] && continue
      payload="${payload//$token/[redacted: suspected secret]}"
    done <<<"$hits"

    remaining="$(_sink_detect_entropy_tokens "$payload")"
    if [[ -n "$remaining" ]]; then
      printf 'QUARANTINE: unresolved high-entropy tokens in %s payload\n' "$sink" >&2
      printf '%s\n' "$payload"
      return 1
    fi
  fi

  printf '%s\n' "$payload"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
