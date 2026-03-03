#!/usr/bin/env bash

collect_human_messages() {
  local thread_ts="${1:-}"

  if ! declare -F thread_archival_fetch_messages >/dev/null 2>&1; then
    printf '\n'
    return 0
  fi

  thread_archival_fetch_messages "$thread_ts" 2>/dev/null \
    | awk -F'\t' 'NF >= 4 { if (tolower($3) != "true" && $3 != "1") print }'
}

summarize_thread() {
  local messages="${1:-}"

  if declare -F thread_archival_summarizer >/dev/null 2>&1; then
    thread_archival_summarizer "$messages"
    return 0
  fi

  printf '### Human debugging insights\n'
  printf '%s\n' "$messages" | awk -F'\t' 'NF>=4 {print "- @"$2": "$4}' | sed -n '1,10p'
}

_thread_archival_marker() {
  local incident_id="$1"
  local pass_type="$2"
  printf '<!-- archival:%s:%s -->' "$incident_id" "$pass_type"
}

_thread_archival_find_comment_by_marker() {
  local ticket_id="$1"
  local marker="$2"
  if ! declare -F thread_archival_list_comments >/dev/null 2>&1; then
    return 1
  fi
  thread_archival_list_comments "$ticket_id" 2>/dev/null | awk -F'\t' -v m="$marker" '$0 ~ m {print $1; exit}'
}

post_archival_comment() {
  local ticket_id="${1:-}"
  local summary="${2:-}"
  local pass_type="${3:-final}"
  local incident_id="${4:-}"

  local marker body existing_id
  marker="$(_thread_archival_marker "$incident_id" "$pass_type")"
  body=$(cat <<EOF_MD
${marker}
## Resolution Context (${pass_type})

${summary}
EOF_MD
)

  existing_id="$(_thread_archival_find_comment_by_marker "$ticket_id" "$marker" || true)"
  if [[ -n "$existing_id" ]] && declare -F thread_archival_update_comment >/dev/null 2>&1; then
    thread_archival_update_comment "$existing_id" "$body" >/dev/null
  elif declare -F thread_archival_create_comment >/dev/null 2>&1; then
    thread_archival_create_comment "$ticket_id" "$body" >/dev/null
  fi

  if [[ "$pass_type" == "final" ]] && declare -F thread_archival_list_comments >/dev/null 2>&1 && declare -F thread_archival_update_comment >/dev/null 2>&1; then
    thread_archival_list_comments "$ticket_id" 2>/dev/null \
      | awk -F'\t' -v id="$incident_id" '$0 ~ "<!-- archival:" id ":interim -->" {print $1"\t"$0}' \
      | while IFS=$'\t' read -r comment_id _rest; do
          [[ -z "$comment_id" ]] && continue
          local existing_body
          existing_body="$(thread_archival_get_comment "$comment_id" 2>/dev/null || true)"
          if [[ "$existing_body" != *"Superseded by final resolution context"* ]]; then
            thread_archival_update_comment "$comment_id" "(Superseded by final resolution context)\n\n${existing_body}" >/dev/null
          fi
        done
  fi
}

archive_thread() {
  local slack_thread_ts="${1:-}"
  local incident_id="${2:-}"
  local linear_ticket_id="${3:-}"
  local pass_type="${4:-final}"

  local messages
  messages="$(collect_human_messages "$slack_thread_ts")"
  if [[ -z "$messages" ]]; then
    printf 'skipped\tno_human_messages\n'
    return 0
  fi

  local summary
  summary="$(summarize_thread "$messages")"
  post_archival_comment "$linear_ticket_id" "$summary" "$pass_type" "$incident_id"
  printf 'archived\t%s\n' "$pass_type"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi
