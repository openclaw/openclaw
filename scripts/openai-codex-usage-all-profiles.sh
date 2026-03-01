#!/usr/bin/env bash
set -euo pipefail

# Fetch usage stats for all openai-codex OAuth profiles in an agent auth store.
#
# Notes:
# - Uses per-profile OAuth access tokens from auth-profiles.json
# - Tries modern costs endpoint first, then legacy dashboard usage endpoint
# - Prints a compact table + writes raw JSON responses to ./tmp/openai-usage/<timestamp>/
#
# Usage:
#   scripts/openai-codex-usage-all-profiles.sh
#   scripts/openai-codex-usage-all-profiles.sh --agent main --days 30
#   scripts/openai-codex-usage-all-profiles.sh --auth-file ~/.openclaw/agents/main/agent/auth-profiles.json
#   scripts/openai-codex-usage-all-profiles.sh --dry-run

AGENT="main"
AUTH_FILE=""
DAYS=30
DRY_RUN=0
OUT_DIR=""

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
    -h|--help)
      sed -n '1,60p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
if [[ -z "$AUTH_FILE" ]]; then
  AUTH_FILE="$OPENCLAW_HOME/agents/$AGENT/agent/auth-profiles.json"
fi

if [[ ! -f "$AUTH_FILE" ]]; then
  echo "error: auth file not found: $AUTH_FILE" >&2
  exit 1
fi

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "error: --days must be an integer" >&2
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

mapfile -t PROFILE_IDS < <(jq -r '
  .profiles
  | to_entries[]
  | select(.value.provider=="openai-codex" and .value.type=="oauth")
  | .key
' "$AUTH_FILE")

if [[ ${#PROFILE_IDS[@]} -eq 0 ]]; then
  echo "No openai-codex oauth profiles found in $AUTH_FILE"
  exit 0
fi

printf "%-28s %-8s %-14s %-10s\n" "PROFILE" "STATUS" "USAGE_USD" "ENDPOINT"
printf "%s\n" "--------------------------------------------------------------------------------"

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
  # Try modern costs schema first, then legacy schema.
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

for pid in "${PROFILE_IDS[@]}"; do
  token="$(jq -r --arg p "$pid" '.profiles[$p].access // empty' "$AUTH_FILE")"
  if [[ -z "$token" ]]; then
    printf "%-28s %-8s %-14s %-10s\n" "$pid" "no-token" "-" "-"
    continue
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    printf "%-28s %-8s %-14s %-10s\n" "$pid" "dry-run" "-" "costs"
    continue
  fi

  costs_file="$OUT_DIR/${pid//[:\/]/_}.costs.json"
  legacy_file="$OUT_DIR/${pid//[:\/]/_}.legacy.json"

  code="$(fetch_costs "$token" "$costs_file")"
  endpoint="costs"
  status="ok"

  if [[ "$code" != "200" ]]; then
    code2="$(fetch_legacy "$token" "$legacy_file")"
    endpoint="legacy"
    if [[ "$code2" != "200" ]]; then
      status="http:$code/$code2"
      printf "%-28s %-8s %-14s %-10s\n" "$pid" "$status" "-" "$endpoint"
      continue
    fi
    use_file="$legacy_file"
  else
    use_file="$costs_file"
  fi

  amount="$(extract_amount "$use_file")"
  if [[ -z "$amount" ]]; then
    status="ok?"
    amount="-"
  fi

  printf "%-28s %-8s %-14s %-10s\n" "$pid" "$status" "$amount" "$endpoint"
done

echo
echo "Raw responses written to: $OUT_DIR"
