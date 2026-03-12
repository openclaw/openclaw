#!/usr/bin/env bash

timeline_now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

timeline_event_build() {
  local source="${1:-unknown}"
  local event="${2:-unknown}"
  local scope="${3:-global}"
  local observed_at="${4:-$(timeline_now_utc)}"
  local severity="${5:-info}"
  local summary="${6:-}"
  local payload_json="${7-}"
  [[ -n "$payload_json" ]] || payload_json='{}'

  jq -nc \
    --arg version "sre.timeline-event.v1" \
    --arg source "$source" \
    --arg event "$event" \
    --arg scope "$scope" \
    --arg observed_at "$observed_at" \
    --arg severity "$severity" \
    --arg summary "$summary" \
    --argjson payload "$payload_json" \
    '{
      version: $version,
      source: $source,
      event: $event,
      scope: $scope,
      observed_at: $observed_at,
      severity: $severity,
      summary: $summary,
      payload: $payload
    }'
}

timeline_merge_sort_ndjson() {
  jq -Rsc -r '
    split("\n")
    | map(select(length > 0) | fromjson)
    | sort_by(.observed_at // "", .source // "", .event // "", .scope // "")
    | unique_by([.observed_at // "", .source // "", .event // "", .scope // "", .summary // ""])
    | .[]
    | @json
  '
}

timeline_summary_block() {
  local timeline_ndjson="${1:-}"
  local max_items="${2:-6}"
  [[ -n "$timeline_ndjson" ]] || return 0

  printf '%s\n' "$timeline_ndjson" \
    | jq -Rsc --argjson max_items "$max_items" '
      split("\n")
      | map(select(length > 0) | fromjson)
      | sort_by(.observed_at // "", .source // "", .event // "", .scope // "")
      | reverse
      | .[:$max_items]
      | if length == 0 then empty else
          (
            ["Recent change window:"]
            + map("- [\(.severity // "info")] \(.observed_at // "n/a") \(.summary // (.event // "change"))")
          )[]
        end
    ' 2>/dev/null || true
}
