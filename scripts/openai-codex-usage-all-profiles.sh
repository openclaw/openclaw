#!/usr/bin/env bash
set -euo pipefail

# Fetch usage stats for all openai-codex OAuth profiles in agent auth stores.
#
# Notes:
# - Uses per-profile OAuth access tokens from auth-profiles.json
# - Tries modern costs endpoint first, then legacy dashboard usage endpoint
# - Prints a compact table by default
# - Optional JSON output with --json
# - Writes raw API responses under ./tmp/openai-usage/<timestamp>/
#
# Usage:
#   scripts/openai-codex-usage-all-profiles.sh
#   scripts/openai-codex-usage-all-profiles.sh --agent main --days 30
#   scripts/openai-codex-usage-all-profiles.sh --all-agents --json
#   scripts/openai-codex-usage-all-profiles.sh --auth-file ~/.openclaw/agents/main/agent/auth-profiles.json
#   scripts/openai-codex-usage-all-profiles.sh --dry-run

AGENT="main"
AUTH_FILE=""
DAYS=30
DRY_RUN=0
OUT_DIR=""
JSON_OUT=0
ALL_AGENTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT="${2:-}"
      shift 2
      ;;
    --auth-file)
      AUTH_FILE="${2:-}"
      shift 2
      ;;
    --days)
      DAYS="${2:-30}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --json)
      JSON_OUT=1
      shift
      ;;
    --all-agents)
      ALL_AGENTS=1
      shift
      ;;
    -h|--help)
      sed -n '1,80p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "error: --days must be an integer" >&2
  exit 1
fi

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

declare -a AUTH_FILES=()
if [[ -n "$AUTH_FILE" ]]; then
  AUTH_FILES+=("$AUTH_FILE")
elif [[ "$ALL_AGENTS" == "1" ]]; then
  for f in "$OPENCLAW_HOME"/agents/*/agent/auth-profiles.json; do
    [[ -f "$f" ]] && AUTH_FILES+=("$f")
  done
else
  AUTH_FILES+=("$OPENCLAW_HOME/agents/$AGENT/agent/auth-profiles.json")
fi

if [[ ${#AUTH_FILES[@]} -eq 0 ]]; then
  echo "error: no auth stores found" >&2
  exit 1
fi

now_epoch="$(date +%s)"
start_epoch="$(( now_epoch - DAYS*86400 ))"
start_date="$(date -u -d "@$start_epoch" +%F 2>/dev/null || date -u -r "$start_epoch" +%F)"
end_date="$(date -u +%F)"

stamp="$(date +%Y%m%d-%H%M%S)"
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="tmp/openai-usage/$stamp"
fi
mkdir -p "$OUT_DIR"

fetch_costs() {
  local token="$1"
  local out="$2"
  local code
  code=$(curl -sS -o "$out" -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    "https://api.openai.com/v1/organization/costs?start_time=$start_epoch&end_time=$now_epoch&bucket_width=1d&limit=$DAYS" || true)
  echo "$code"
}

fetch_legacy() {
  local token="$1"
  local out="$2"
  local code
  code=$(curl -sS -o "$out" -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    "https://api.openai.com/dashboard/billing/usage?start_date=$start_date&end_date=$end_date" || true)
  echo "$code"
}

extract_amount() {
  local file="$1"
  jq -r '
    if (type=="object" and has("data")) then
      ([.data[]?.results[]?.amount?.value] | map(select(.!=null)) | add) // empty
    elif (type=="object" and has("total_usage")) then
      (.total_usage / 100.0)
    else
      empty
    end
  ' "$file" 2>/dev/null || true
}

results_jsonl="$OUT_DIR/results.jsonl"
: > "$results_jsonl"

if [[ "$JSON_OUT" != "1" ]]; then
  printf "%-16s %-28s %-10s %-14s %-10s\n" "AGENT" "PROFILE" "STATUS" "USAGE_USD" "ENDPOINT"
  printf "%s\n" "-----------------------------------------------------------------------------------------------"
fi

for auth_path in "${AUTH_FILES[@]}"; do
  if [[ ! -f "$auth_path" ]]; then
    echo "warn: auth file not found: $auth_path" >&2
    continue
  fi

  agent_name="$(echo "$auth_path" | sed -E 's#^.*/agents/([^/]+)/agent/auth-profiles.json#\1#')"

  mapfile -t PROFILE_IDS < <(jq -r '
    .profiles
    | to_entries[]?
    | select(.value.provider=="openai-codex" and .value.type=="oauth")
    | .key
  ' "$auth_path")

  for pid in "${PROFILE_IDS[@]}"; do
    token="$(jq -r --arg p "$pid" '.profiles[$p].access // empty' "$auth_path")"
    status="ok"
    endpoint="costs"
    amount="-"

    if [[ -z "$token" ]]; then
      status="no-token"
      endpoint="-"
    elif [[ "$DRY_RUN" == "1" ]]; then
      status="dry-run"
      endpoint="costs"
    else
      safe_agent="${agent_name//[^a-zA-Z0-9_.-]/_}"
      safe_pid="${pid//[:\/]/_}"
      costs_file="$OUT_DIR/${safe_agent}.${safe_pid}.costs.json"
      legacy_file="$OUT_DIR/${safe_agent}.${safe_pid}.legacy.json"

      code="$(fetch_costs "$token" "$costs_file")"
      if [[ "$code" == "200" ]]; then
        use_file="$costs_file"
      else
        code2="$(fetch_legacy "$token" "$legacy_file")"
        endpoint="legacy"
        if [[ "$code2" == "200" ]]; then
          use_file="$legacy_file"
        else
          status="http:$code/$code2"
          use_file=""
        fi
      fi

      if [[ -n "${use_file:-}" ]]; then
        amount="$(extract_amount "$use_file")"
        if [[ -z "$amount" ]]; then
          status="ok?"
          amount="-"
        fi
      fi
    fi

    jq -nc \
      --arg agent "$agent_name" \
      --arg profile "$pid" \
      --arg status "$status" \
      --arg endpoint "$endpoint" \
      --arg usageUsd "$amount" \
      '{agent:$agent,profile:$profile,status:$status,usageUsd:$usageUsd,endpoint:$endpoint}' \
      >> "$results_jsonl"

    if [[ "$JSON_OUT" != "1" ]]; then
      printf "%-16s %-28s %-10s %-14s %-10s\n" "$agent_name" "$pid" "$status" "$amount" "$endpoint"
    fi
  done
done

if [[ "$JSON_OUT" == "1" ]]; then
  jq -s --arg outDir "$OUT_DIR" '{results: ., outDir: $outDir}' "$results_jsonl"
else
  echo
  echo "Raw responses written to: $OUT_DIR"
fi
