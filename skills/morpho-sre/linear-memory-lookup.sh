#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/lib-linear-preflight.sh" ]]; then
  # shellcheck source=lib-linear-preflight.sh
  source "${SCRIPT_DIR}/lib-linear-preflight.sh"
fi

LINEAR_MEMORY_TIMEOUT_SECONDS="${LINEAR_MEMORY_TIMEOUT_SECONDS:-5}"
LINEAR_MEMORY_DEFAULT_LIMIT="${LINEAR_MEMORY_DEFAULT_LIMIT:-5}"
LINEAR_MEMORY_TEAM_NAME="${LINEAR_MEMORY_TEAM_NAME:-Platform}"
LINEAR_MEMORY_LOOKBACK_DAYS="${LINEAR_MEMORY_LOOKBACK_DAYS:-90}"
LINEAR_MEMORY_FETCH_LIMIT="${LINEAR_MEMORY_FETCH_LIMIT:-100}"
LINEAR_API_URL="${LINEAR_API_URL:-https://api.linear.app/graphql}"
LINEAR_CURL_BIN="${LINEAR_CURL_BIN:-curl}"

_linear_memory_auth_token() {
  local token="${LINEAR_API_KEY:-${LINEAR_TOKEN:-}}"
  [[ -n "$token" ]] || return 10
  printf '%s\n' "$token"
}

_linear_memory_since_iso() {
  local lookback_days="$1"
  if date -u -v-"${lookback_days}"d +"%Y-%m-%dT%H:%M:%SZ" >/dev/null 2>&1; then
    date -u -v-"${lookback_days}"d +"%Y-%m-%dT%H:%M:%SZ"
    return 0
  fi
  python3 - "$lookback_days" <<'PY'
from datetime import datetime, timedelta, timezone
import sys
days = int(sys.argv[1])
ts = datetime.now(timezone.utc) - timedelta(days=days)
print(ts.strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

_linear_memory_tokenize_query() {
  local query="${1:-}"
  printf '%s\n' "$query" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs '[:alnum:]' '\n' \
    | awk 'length($0) >= 3 { print }' \
    | awk '!seen[$0]++' \
    | head -n 20 \
    | jq -Rsc 'split("\n") | map(select(length > 0))'
}

_linear_memory_default_provider() {
  local query="${1:-}"
  local limit="${2:-$LINEAR_MEMORY_DEFAULT_LIMIT}"
  local fetch_limit="${LINEAR_MEMORY_FETCH_LIMIT:-100}"
  local lookback_days="${LINEAR_MEMORY_LOOKBACK_DAYS:-90}"
  local now_epoch since_iso token query_tokens_json graphql_query vars_json payload response

  command -v jq >/dev/null 2>&1 || return 11
  command -v "$LINEAR_CURL_BIN" >/dev/null 2>&1 || return 11

  token="$(_linear_memory_auth_token)" || return $?
  since_iso="$(_linear_memory_since_iso "$lookback_days")" || return 11
  now_epoch="$(date +%s)"
  query_tokens_json="$(_linear_memory_tokenize_query "$query")"

  if ! [[ "$fetch_limit" =~ ^[0-9]+$ ]] || [[ "$fetch_limit" -lt 1 ]]; then
    fetch_limit=100
  fi
  if [[ "$fetch_limit" -gt 250 ]]; then
    fetch_limit=250
  fi

  graphql_query='query($first:Int!,$team:String!,$since:DateTimeOrDuration!){ issues(first:$first, filter:{team:{name:{eq:$team}}, createdAt:{gte:$since}}){ nodes { identifier title description createdAt labels { nodes { name } } } } }'
  vars_json="$(
    jq -nc \
      --argjson first "$fetch_limit" \
      --arg team "$LINEAR_MEMORY_TEAM_NAME" \
      --arg since "$since_iso" \
      '{ first: $first, team: $team, since: $since }'
  )" || return 11
  payload="$(jq -nc --arg query "$graphql_query" --argjson variables "$vars_json" '{ query: $query, variables: $variables }')" || return 11

  response="$(
    "$LINEAR_CURL_BIN" -fsS "$LINEAR_API_URL" \
      -H "Authorization: ${token}" \
      -H "Content-Type: application/json" \
      --data "$payload"
  )" || return 12

  printf '%s\n' "$response" | jq -e . >/dev/null 2>&1 || return 12
  if printf '%s\n' "$response" | jq -e '.errors and (.errors | length > 0)' >/dev/null 2>&1; then
    return 13
  fi

  printf '%s\n' "$response" | jq -r \
    --argjson now "$now_epoch" \
    --argjson limit "$limit" \
    --argjson tokens "$query_tokens_json" '
      def sanitize:
        tostring
        | gsub("[\r\n\t]+"; " ")
        | gsub("[[:space:]]+"; " ")
        | sub("^[[:space:]]+"; "")
        | sub("[[:space:]]+$"; "");

      def labels_lc($item):
        (($item.labels.nodes // []) | map((.name // "") | ascii_downcase));

      def has_bug_monitoring($item):
        (labels_lc($item) | index("bug")) != null
        and (labels_lc($item) | index("monitoring")) != null;

      def is_incident_like($item):
        (($item.title // "") | test("(?i)\\[incident\\]|\\bincident\\b"))
        or has_bug_monitoring($item);

      def token_score($text):
        [ $tokens[]? | select(($text | contains(.))) ] | length;

      def resolution_context($description):
        (try ($description | capture("(?is)##\\s*Resolution Context\\s*(?<ctx>.*?)(\\n##\\s|$)").ctx) catch "") as $ctx
        | if ($ctx | length) > 0 then $ctx else $description end
        | sanitize
        | .[0:220];

      (.data.issues.nodes // [])
      | map({
          id: (.identifier // ""),
          title: ((.title // "") | sanitize | .[0:180]),
          description: (.description // ""),
          createdAt: (.createdAt // ""),
          incident_like: is_incident_like(.),
          text_lc: (((.title // "") + " " + (.description // "") + " " + ((.labels.nodes // []) | map(.name // "") | join(" "))) | ascii_downcase)
        })
      | map(. + {
          score: (if .incident_like then 3 else 0 end) + token_score(.text_lc),
          days_ago: (
            if (.createdAt | length) > 0
            then ((($now - ((.createdAt | fromdateiso8601?) // $now)) / 86400) | floor)
            else 0
            end
          ),
          resolution_context: resolution_context(.description)
        })
      | map(select(.id != "" and .score > 0))
      | sort_by(-.score, .days_ago, .id)
      | .[:$limit]
      | .[]
      | [ .id, .title, .resolution_context, (.days_ago | tostring) ]
      | @tsv
    ' || return 12
}

linear_memory_provider() {
  local query="$1"
  local limit="$2"
  if [[ -n "${LINEAR_MEMORY_PROVIDER_SCRIPT:-}" && -x "${LINEAR_MEMORY_PROVIDER_SCRIPT}" ]]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout "${LINEAR_MEMORY_TIMEOUT_SECONDS}s" "$LINEAR_MEMORY_PROVIDER_SCRIPT" "$query" "$limit"
    else
      "$LINEAR_MEMORY_PROVIDER_SCRIPT" "$query" "$limit"
    fi
    return $?
  fi
  _linear_memory_default_provider "$query" "$limit"
}

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
  if [[ -z "${LINEAR_MEMORY_PROVIDER_SCRIPT:-}" || ! -x "${LINEAR_MEMORY_PROVIDER_SCRIPT}" ]]; then
    return 14
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "${LINEAR_MEMORY_TIMEOUT_SECONDS}s" "$LINEAR_MEMORY_PROVIDER_SCRIPT" "$query" "$limit"
  else
    "$LINEAR_MEMORY_PROVIDER_SCRIPT" "$query" "$limit"
  fi
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

  if output="$(_linear_memory_run_provider "$query" "$limit" 2>/dev/null)"; then
    rc=0
  else
    rc=$?
  fi

  if [[ "$rc" -eq 124 ]]; then
    printf 'status\tskipped\ttimeout\n'
    return 0
  fi

  if [[ "$rc" -eq 10 ]]; then
    printf 'status\tskipped\tlinear_unavailable\n'
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
