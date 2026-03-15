#!/usr/bin/env bash
set -euo pipefail

# Fetch Codex usage quota snapshots per openai-codex profile from auth stores.
# Uses the same endpoint OpenClaw uses internally:
#   https://chatgpt.com/backend-api/wham/usage
#
# Usage:
#   scripts/openai-codex-usage-all-profiles.sh
#   scripts/openai-codex-usage-all-profiles.sh --agent main
#   scripts/openai-codex-usage-all-profiles.sh --all-agents --json
#   scripts/openai-codex-usage-all-profiles.sh --auth-file ~/.openclaw/agents/main/agent/auth-profiles.json
#   scripts/openai-codex-usage-all-profiles.sh --dry-run

AGENT="main"
AUTH_FILE=""
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
      sed -n '1,70p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

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

stamp="$(date +%Y%m%d-%H%M%S)"
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="tmp/openai-usage/$stamp"
fi
mkdir -p "$OUT_DIR"

results_jsonl="$OUT_DIR/results.jsonl"
: > "$results_jsonl"

if [[ "$JSON_OUT" != "1" ]]; then
  printf "%-16s %-28s %-10s %-8s %-8s %-16s %s\n" "AGENT" "PROFILE" "STATUS" "3H_USED" "DAY_USED" "PLAN" "RESETS"
  printf "%s\n" "----------------------------------------------------------------------------------------------------------------"
fi

for auth_path in "${AUTH_FILES[@]}"; do
  [[ -f "$auth_path" ]] || continue
  agent_name="$(echo "$auth_path" | sed -E 's#^.*/agents/([^/]+)/agent/auth-profiles.json#\1#')"

  mapfile -t PROFILE_IDS < <(jq -r '
    .profiles
    | to_entries[]?
    | select(.value.provider=="openai-codex" and .value.type=="oauth")
    | .key
  ' "$auth_path")

  for pid in "${PROFILE_IDS[@]}"; do
    token="$(jq -r --arg p "$pid" '.profiles[$p].access // empty' "$auth_path")"
    account_id="$(jq -r --arg p "$pid" '.profiles[$p].accountId // empty' "$auth_path")"

    status="ok"
    p_used="-"
    s_used="-"
    plan="-"
    resets="-"

    safe_agent="${agent_name//[^a-zA-Z0-9_.-]/_}"
    safe_pid="${pid//[:\/]/_}"
    out="$OUT_DIR/${safe_agent}.${safe_pid}.codex-usage.json"

    if [[ "$DRY_RUN" == "1" ]]; then
      status="dry-run"
    elif [[ -z "$token" ]]; then
      status="no-token"
    else
      hdr=(-H "Authorization: Bearer $token" -H "User-Agent: CodexBar" -H "Accept: application/json")
      if [[ -n "$account_id" ]]; then
        hdr+=(-H "ChatGPT-Account-Id: $account_id")
      fi

      code=$(curl -sS -o "$out" -w "%{http_code}" "https://chatgpt.com/backend-api/wham/usage" "${hdr[@]}" || true)
      if [[ "$code" != "200" ]]; then
        status="http:$code"
      else
        p_used="$(jq -r '.rate_limit.primary_window.used_percent // empty' "$out" 2>/dev/null || true)"
        s_used="$(jq -r '.rate_limit.secondary_window.used_percent // empty' "$out" 2>/dev/null || true)"
        p_reset="$(jq -r '.rate_limit.primary_window.reset_at // empty' "$out" 2>/dev/null || true)"
        s_reset="$(jq -r '.rate_limit.secondary_window.reset_at // empty' "$out" 2>/dev/null || true)"
        plan_type="$(jq -r '.plan_type // empty' "$out" 2>/dev/null || true)"
        credits="$(jq -r '.credits.balance // empty' "$out" 2>/dev/null || true)"

        [[ -n "$p_used" ]] || p_used="-"
        [[ -n "$s_used" ]] || s_used="-"

        if [[ -n "$plan_type" || -n "$credits" ]]; then
          if [[ -n "$plan_type" && -n "$credits" ]]; then
            plan="$plan_type ($$credits)"
          elif [[ -n "$plan_type" ]]; then
            plan="$plan_type"
          else
            plan="$$credits"
          fi
        fi

        reset_parts=()
        [[ -n "$p_reset" ]] && reset_parts+=("3h:$p_reset")
        [[ -n "$s_reset" ]] && reset_parts+=("day:$s_reset")
        if [[ ${#reset_parts[@]} -gt 0 ]]; then
          resets="$(IFS=','; echo "${reset_parts[*]}")"
        fi
      fi
    fi

    jq -nc \
      --arg agent "$agent_name" \
      --arg profile "$pid" \
      --arg status "$status" \
      --arg primaryUsed "$p_used" \
      --arg secondaryUsed "$s_used" \
      --arg plan "$plan" \
      --arg resets "$resets" \
      '{agent:$agent,profile:$profile,status:$status,primaryUsedPercent:$primaryUsed,secondaryUsedPercent:$secondaryUsed,plan:$plan,resets:$resets}' \
      >> "$results_jsonl"

    if [[ "$JSON_OUT" != "1" ]]; then
      printf "%-16s %-28s %-10s %-8s %-8s %-16s %s\n" "$agent_name" "$pid" "$status" "$p_used" "$s_used" "$plan" "$resets"
    fi
  done
done

if [[ "$JSON_OUT" == "1" ]]; then
  jq -s --arg outDir "$OUT_DIR" '{results: ., outDir: $outDir}' "$results_jsonl"
else
  echo
  echo "Raw responses written to: $OUT_DIR"
fi
