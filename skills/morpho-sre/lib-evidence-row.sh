#!/usr/bin/env bash

evidence_row_now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

evidence_row_stale_after() {
  local observed_at="${1:-}"
  local ttl_seconds="${2:-300}"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$observed_at" "$ttl_seconds" <<'PY'
from datetime import datetime, timedelta, timezone
import sys

observed_at = sys.argv[1].strip()
ttl_seconds = int(sys.argv[2])
if not observed_at:
    observed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
dt = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
print((dt + timedelta(seconds=ttl_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
    return 0
  fi

  date -u -d "${observed_at} + ${ttl_seconds} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || evidence_row_now_utc
}

evidence_row_build() {
  local source="${1:-unknown}"
  local kind="${2:-unknown}"
  local scope="${3:-global}"
  local observed_at="${4:-$(evidence_row_now_utc)}"
  local payload_json="${5-}"
  local collection_error="${6:-}"
  local confidence="${7:-0}"
  local ttl_seconds="${8:-300}"
  [[ -n "$payload_json" ]] || payload_json='{}'

  local stale_after
  stale_after="$(evidence_row_stale_after "$observed_at" "$ttl_seconds")"

  jq -nc \
    --arg version "sre.evidence-row.v1" \
    --arg source "$source" \
    --arg kind "$kind" \
    --arg scope "$scope" \
    --arg observed_at "$observed_at" \
    --arg stale_after "$stale_after" \
    --arg collection_error "$collection_error" \
    --argjson payload "$payload_json" \
    --argjson ttl_seconds "$ttl_seconds" \
    --argjson confidence "$confidence" \
    '{
      version: $version,
      source: $source,
      kind: $kind,
      scope: $scope,
      observed_at: $observed_at,
      ttl_seconds: $ttl_seconds,
      stale_after: $stale_after,
      confidence: $confidence,
      entity_ids: [],
      payload: $payload,
      collection_error: (if $collection_error == "" then null else $collection_error end)
    }'
}

evidence_row_with_freshness() {
  local row_json="${1:-{}}"
  local ttl_seconds="${2:-300}"
  local observed_at
  observed_at="$(printf '%s\n' "$row_json" | jq -r '.observed_at // empty' 2>/dev/null || true)"
  local stale_after
  stale_after="$(evidence_row_stale_after "$observed_at" "$ttl_seconds")"

  printf '%s\n' "$row_json" \
    | jq -c \
      --arg stale_after "$stale_after" \
      --argjson ttl_seconds "$ttl_seconds" \
      '.ttl_seconds = $ttl_seconds | .stale_after = $stale_after'
}

evidence_row_with_entities() {
  local row_json="${1-}"
  shift || true
  [[ -n "$row_json" ]] || row_json='{}'

  if [[ "$#" -eq 0 ]]; then
    printf '%s\n' "$row_json"
    return 0
  fi

  jq -nc --argjson row "$row_json" --args "$@" '
    $ARGS.positional
    | map(select(. != ""))
    | unique as $entity_ids
    | $row + {entity_ids: $entity_ids}
  '
}

evidence_rows_write_ndjson() {
  local output_file="${1:?output_file required}"
  shift || true

  mkdir -p "${output_file%/*}"
  : >"$output_file"
  local row
  for row in "$@"; do
    [[ -n "$row" ]] || continue
    printf '%s\n' "$row" >>"$output_file"
  done
}
