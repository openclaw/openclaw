#!/usr/bin/env bash
#
# models_connectivity_check — probe every dashboard-active LLM model
# ─────────────────────────────────────────────────────────────────────────────
# Sends a tiny completion ("hi", max_tokens=16) to every model the dashboard
# offers, and reports status + latency BY PROVIDER and BY MODEL. Total cost of
# a full run is ~20 tokens across all models — effectively free.
#
# The probe executes ON the key host (default: EU/1stClaw) so provider API
# keys are read from the donor agent's docker.env at runtime and never leave
# that machine. Nothing secret is printed or copied back — only statuses.
#
# Model list mirrors openclaw-dashboard
#   app/api/public/chat/[agentName]/models/route.ts  (OPENROUTER_MODELS/VENICE_MODELS)
# — keep the two in sync when models are added or retired.
#
# Usage:
#   ./models_connectivity_check.sh                 # print report + write state files
#   EMAIL_TO=liran@agentglob.com ./models_connectivity_check.sh   # + email it
#
# State files (consumed by the 06:00 fleet diagnostic for ONE combined email
# and a single bug_list AUTOSCAN entry per failing model):
#   REPORT_FILE  human report           (default /var/tmp/agentglob-models-report.txt)
#   ISSUES_FILE  ISSUE|... lines        (default /var/tmp/agentglob-model-issues.txt)
#
# Env overrides:
#   SSH_KEY     ssh key for the key host       (default ~/.ssh/hetzner-openclaw)
#   KEY_HOST    host holding provider keys     (default 89.167.70.46)
#   KEY_AGENT   agent whose docker.env donates the keys (default cashtronics)
#   TIMEOUT_S   per-model curl timeout, seconds (default 45)
#   EMAIL_TO    if set, email the report via msmtp (needs ~/.msmtprc)
#
set -uo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/hetzner-openclaw}"
KEY_HOST="${KEY_HOST:-89.167.70.46}"
KEY_AGENT="${KEY_AGENT:-cashtronics}"   # donor must have both provider keys
TIMEOUT_S="${TIMEOUT_S:-45}"
EMAIL_TO="${EMAIL_TO:-}"
REPORT_FILE="${REPORT_FILE:-/var/tmp/agentglob-models-report.txt}"
ISSUES_FILE="${ISSUES_FILE:-/var/tmp/agentglob-model-issues.txt}"

# ── Active model catalog (sync with the dashboard models route) ──────────────
OPENROUTER_MODELS="z-ai/glm-5.2 anthropic/claude-opus-4.8 anthropic/claude-sonnet-4.6 openai/gpt-5.5 deepseek/deepseek-v4-flash"
VENICE_MODELS="claude-opus-4-6 zai-org-glm-4.7 grok-41-fast qwen3-235b-a22b-instruct-2507 hermes-3-llama-3.1-405b"

# ── Remote probe: runs on KEY_HOST; emits RESULT|provider|model|verdict|http|secs
results="$(ssh -i "$SSH_KEY" -o ConnectTimeout=15 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  "root@${KEY_HOST}" \
  "OPENROUTER_MODELS='${OPENROUTER_MODELS}' VENICE_MODELS='${VENICE_MODELS}' KEY_AGENT='${KEY_AGENT}' TIMEOUT_S='${TIMEOUT_S}' bash -s" 2>/dev/null <<'REMOTE'
set -uo pipefail
AGENTS_DIR="/root/.openclaw/agents"
# getkey NAME [provider] — reads ONLY the designated donor agent (KEY_AGENT).
# Value is used in-process for the probe call and never printed.
# Order: donor docker.env → donor openclaw.json models.providers.<provider>.apiKey
getkey(){
  local v
  v=$(grep -E "^${1}=" "${AGENTS_DIR}/${KEY_AGENT}/docker.env" 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -z "$v" ] && [ -n "${2:-}" ]; then
    v=$(python3 -c "
import json
try: print(json.load(open('${AGENTS_DIR}/${KEY_AGENT}/openclaw.json'))['models']['providers']['$2']['apiKey'])
except Exception: pass" 2>/dev/null)
  fi
  printf '%s' "$v"
}

probe(){ # $1 provider  $2 base_url  $3 key  $4 model
  local t0 t1 http dur verdict
  t0=$(date +%s.%N)
  http=$(curl -sS -m "$TIMEOUT_S" -o /tmp/.probe.json -w '%{http_code}' \
    "$2/chat/completions" \
    -H "Authorization: Bearer $3" -H "Content-Type: application/json" \
    -d "{\"model\":\"$4\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16,\"temperature\":0}" \
    2>/dev/null) || http="000"
  t1=$(date +%s.%N)
  dur=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')
  case "$http" in
    200)      verdict=OK ;;
    000)      verdict=TIMEOUT ;;
    401|403)  verdict=AUTH_FAIL ;;
    404)      verdict=NOT_FOUND ;;
    429)      verdict=RATE_LIMIT ;;
    5*)       verdict=SERVER_ERR ;;
    *)        verdict=FAIL ;;
  esac
  echo "RESULT|$1|$4|$verdict|$http|${dur}s"
}

orkey="$(getkey OPENROUTER_API_KEY openrouter)"
if [ -n "$orkey" ]; then
  for m in $OPENROUTER_MODELS; do probe openrouter "https://openrouter.ai/api/v1" "$orkey" "$m"; done
else
  for m in $OPENROUTER_MODELS; do echo "RESULT|openrouter|$m|SKIP_NO_KEY|-|-"; done
fi

vnkey="$(getkey VENICE_API_KEY venice)"; [ -z "$vnkey" ] && vnkey="$(getkey VENICE_KEY venice)"
if [ -n "$vnkey" ]; then
  for m in $VENICE_MODELS; do probe venice "https://api.venice.ai/api/v1" "$vnkey" "$m"; done
else
  for m in $VENICE_MODELS; do echo "RESULT|venice|$m|SKIP_NO_KEY|-|-"; done
fi
REMOTE
)"

if [[ -z "$results" ]]; then
  echo "ERROR: probe host ${KEY_HOST} unreachable or returned nothing." >&2
  exit 1
fi

# ── Report ───────────────────────────────────────────────────────────────────
now="$(date '+%Y-%m-%d %H:%M:%S %Z')"
report="$(
  echo "LLM model connectivity — ${now}"
  echo "probe: 1-token completion · timeout ${TIMEOUT_S}s · keys from ${KEY_AGENT}@${KEY_HOST}"
  ok_total=0; bad_total=0
  for prov in openrouter venice; do
    echo
    echo "── provider: ${prov} ──"
    ok=0; bad=0
    while IFS='|' read -r _ p model verdict http dur; do
      [[ "$p" == "$prov" ]] || continue
      if [[ "$verdict" == OK ]]; then mark=" OK "; ok=$((ok+1)); else mark="FAIL"; bad=$((bad+1)); fi
      printf '  [%s] %-38s %-12s HTTP %-4s %s\n' "$mark" "$model" "$verdict" "$http" "$dur"
    done <<<"$results"
    echo "  provider total: ${ok} OK / $((ok+bad)) probed"
    ok_total=$((ok_total+ok)); bad_total=$((bad_total+bad))
  done
  echo
  if [[ $bad_total -eq 0 ]]; then
    echo "VERDICT: ALL MODELS RESPONDING (${ok_total}/${ok_total})"
  else
    echo "VERDICT: ${bad_total} MODEL(S) NOT RESPONDING (${ok_total} OK)"
  fi
)"

echo "$report"

# ── State files for the fleet diagnostic to ingest ───────────────────────────
printf '%s\n' "$report" > "$REPORT_FILE" 2>/dev/null || true
{
  seen_nokey=""
  while IFS='|' read -r _ p model verdict http dur; do
    case "$verdict" in
      OK) ;;
      SKIP_NO_KEY)
        case " $seen_nokey " in *" $p "*) ;; *)
          seen_nokey="$seen_nokey $p"
          echo "ISSUE|P2|models|$p|Provider key missing|Donor agent ${KEY_AGENT} has no $p API key; provider unprobed." ;;
        esac ;;
      *)
        echo "ISSUE|P1|models|$p/$model|Model not responding|$verdict (HTTP $http, $dur) on a 1-token probe via $p API." ;;
    esac
  done <<<"$results"
} > "$ISSUES_FILE" 2>/dev/null || true

# ── Optional email ───────────────────────────────────────────────────────────
if [[ -n "$EMAIL_TO" ]] && command -v msmtp >/dev/null 2>&1; then
  bad=$(echo "$report" | grep -c '\[FAIL\]' || true)
  subj="[AgentGlob] Model connectivity $(date +%F) — $([[ $bad -eq 0 ]] && echo 'ALL OK' || echo "${bad} FAILING")"
  printf 'Subject: %s\nFrom: AgentGlob Diagnostics <onetrue2023@gmail.com>\nTo: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' \
    "$subj" "$EMAIL_TO" "$report" | msmtp "$EMAIL_TO" \
    && echo "→ report emailed to $EMAIL_TO" || echo "WARN: email send failed (see ~/.msmtp.log)" >&2
fi
