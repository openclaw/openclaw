#!/usr/bin/env bash
#
# deps-audit-cron — daily dependency audit for the openclaw-dashboard control plane
# ─────────────────────────────────────────────────────────────────────────────
# Runs on the dev server at 05:45 UTC. Two phases, both reuse-first:
#
#   A. NEW deps      — grep the dashboard repo's origin/main tree for external
#                      hosts + infra env vars, diff against docs/DEPENDENCIES.md,
#                      report undocumented candidates (does NOT auto-edit the doc).
#   B. Liveness      — probe each documented dep that nothing else already probes
#                      (OpenRouter is covered by models_connectivity_check.sh;
#                      host/container health by agents_server_diagnostic.sh).
#
# Output mirrors models_connectivity_check.sh: it writes two state files that the
# 06:00 fleet diagnostic ingests for ONE combined email + bug_list AUTOSCAN:
#   REPORT_FILE  human table   (default /var/tmp/agentglob-deps-report.txt)
#   ISSUES_FILE  ISSUE|... lines (default /var/tmp/agentglob-deps-issues.txt)
#
# Secrets never leave the donor host: the rain/telegram tokens are read on EU
# from donor agent `cashtronics` and used in-process there (same single-donor
# rule as the models check). Nothing secret is printed or copied back.
#
# Env overrides: SSH_KEY, KEY_HOST (EU), KEY_AGENT (cashtronics), TIMEOUT_S,
#   DASH_REPO (dashboard checkout), REPORT_FILE, ISSUES_FILE.
#
set -uo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/hetzner-openclaw}"
KEY_HOST="${KEY_HOST:-89.167.70.46}"
KEY_AGENT="${KEY_AGENT:-cashtronics}"
TIMEOUT_S="${TIMEOUT_S:-20}"
DASH_REPO="${DASH_REPO:-/root/AgentGlob_Apps/openclaw-dashboard}"
REPORT_FILE="${REPORT_FILE:-/var/tmp/agentglob-deps-report.txt}"
ISSUES_FILE="${ISSUES_FILE:-/var/tmp/agentglob-deps-issues.txt}"
DASH_URL="https://app.agentglob.com"
REGISTRY="europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway"

report="" ; issues=""
add(){ report="${report}$1"$'\n'; }
iss(){ issues="${issues}$1"$'\n'; }
row(){ add "$(printf '%-22s | %-10s | %-9s | %s' "$1" "$2" "$3" "$4")"; }

# ── Phase A — new/undocumented deps (read origin/main, never the WIP worktree) ─
row "dependency" "documented" "reachable" "note"
new_count=0
if git -C "$DASH_REPO" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$DASH_REPO" fetch -q origin main 2>/dev/null || true
  DOC="$(git -C "$DASH_REPO" show origin/main:docs/DEPENDENCIES.md 2>/dev/null)"
  # Allowlist: schema/spec URLs and non-deps that legitimately appear in code.
  # t.me is the same Telegram dep as the documented api.telegram.org.
  ALLOW='w3\.org|schema\.org|json-schema\.org|example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0|github\.com/[^ ]*/blob|(^|\.)t\.me$'

  # External hosts. Match on the base domain (last two labels) so the doc's
  # shorthand (`{eth,arb,base}-mainnet.g.alchemy.com`) still counts as covered.
  # ponytail: base-domain match can under-report a new subdomain of a known
  # provider — fine; a genuinely new dep brings a new base domain, and quiet
  # beats a daily false-positive that trains you to ignore the section.
  while IFS= read -r host; do
    [ -n "$host" ] || continue
    printf '%s' "$host" | grep -qE "$ALLOW" && continue
    base=$(printf '%s' "$host" | awk -F. 'NF>=2{print $(NF-1)"."$NF} NF<2{print}')
    printf '%s' "$DOC" | grep -qF "$base" && continue
    row "NEW: $host" "N" "?" "add row to DEPENDENCIES.md (external host)"
    iss "ISSUE|P3|deps|-|Undocumented dependency candidate|host ${host} in lib/app — suggested fix: add a row to docs/DEPENDENCIES.md"
    new_count=$((new_count+1))
  done <<EOF
$(git -C "$DASH_REPO" grep -IhoE 'https?://[a-zA-Z0-9._/-]+' origin/main -- lib app/api 2>/dev/null \
  | sed -E 's#https?://([^/"'"'"' )]+).*#\1#' | sort -u)
EOF

  # Infra env vars → only service-shaped names (URL/KEY/HOST/SECRET/TOKEN/BUCKET).
  # ponytail: suffix filter keeps this to real infra deps, not feature flags —
  # a grep vs prose doc is crude, so we only nudge on names that look like deps.
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$DOC" | grep -qF "$ev" && continue
    # Also match the stem (drop the service suffix) so the doc's grouped form
    # `OPENCLAW_GATEWAY_HOST / _PORT / _TOKEN` covers OPENCLAW_GATEWAY_TOKEN.
    stem=$(printf '%s' "$ev" | sed -E 's/_(URL|KEY|HOST|SECRET|TOKEN|BUCKET)$//')
    printf '%s' "$DOC" | grep -qF "$stem" && continue
    row "NEW: $ev" "N" "?" "add row to DEPENDENCIES.md (infra env var)"
    iss "ISSUE|P3|deps|-|Undocumented env var candidate|${ev} in lib/app — suggested fix: add a row to docs/DEPENDENCIES.md"
    new_count=$((new_count+1))
  done <<EOF
$(git -C "$DASH_REPO" grep -IhoE 'process\.env\.[A-Z_0-9]+' origin/main -- lib app/api 2>/dev/null \
  | sed 's/process\.env\.//' | grep -E '_(URL|KEY|HOST|SECRET|TOKEN|BUCKET)$' | sort -u)
EOF
else
  iss "ISSUE|P2|deps|-|Dependency repo missing|${DASH_REPO} is not a git checkout — Phase A skipped."
fi
[ "$new_count" -eq 0 ] && row "(no new deps)" "-" "-" "code matches DEPENDENCIES.md"

# ── Phase B — liveness ────────────────────────────────────────────────────────
# 1. Dashboard (Cloud Run) + Firestore — expected-404 probe.
#    404 counts as success ONLY for this synthetic agent path: models/route.ts
#    runs listAllAgents() (a Firestore read) BEFORE returning 404, so a clean 404
#    proves Cloud Run executed + Firestore read OK. Any 2xx/401/403/5xx/timeout
#    is degraded. (Intentionally depends on that route contract — codex 4879747589.)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT_S" \
  "$DASH_URL/api/public/chat/__deps_probe__/models" 2>/dev/null || echo 000)
if [ "$code" = 404 ]; then
  row "app.agentglob.com" "Y" "Y" "Cloud Run + Firestore OK (expected 404)"
else
  row "app.agentglob.com" "Y" "N" "unexpected HTTP $code (want 404)"
  iss "ISSUE|P1|deps|dashboard|Dashboard/Firestore probe failed|expected-404 probe returned $code — Cloud Run or Firestore degraded."
fi

# 2. Artifact Registry — latest gateway image listable.
digest=$(gcloud artifacts docker images list "$REGISTRY" --sort-by=~UPDATE_TIME \
  --limit=1 --format='value(version)' 2>/dev/null | head -1)
if [ -n "$digest" ]; then
  row "artifact registry" "Y" "Y" "latest ${digest:0:19}…"
else
  row "artifact registry" "Y" "N" "image list failed"
  iss "ISSUE|P2|deps|artifact-registry|Artifact Registry unreachable|gcloud image list returned nothing — new deploys/restarts would fail."
fi

# 3+4. Rain runtime + Telegram API — both need the EU donor (IP-allowlist + token).
donor=$(ssh -i "$SSH_KEY" -o ConnectTimeout=15 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  "root@${KEY_HOST}" "KEY_AGENT='${KEY_AGENT}' TIMEOUT_S='${TIMEOUT_S}' DASH_URL='${DASH_URL}' bash -s" 2>/dev/null <<'REMOTE'
set -uo pipefail
A="/root/.openclaw/agents/${KEY_AGENT}"
# Rain: gateway Bearer token + this host's runtime-allowed IP. Parse body .ok +
# failing checks — the route returns HTTP 200 even when degraded.
GWTOK=$(python3 -c "import json;print(json.load(open('$A/openclaw.json'))['gateway']['auth']['token'])" 2>/dev/null)
if [ -n "$GWTOK" ]; then
  body=$(curl -sS --max-time "$TIMEOUT_S" -H "Authorization: Bearer $GWTOK" "$DASH_URL/api/runtime/rain/health" 2>/dev/null)
  printf '%s' "$body" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("RESULT|rain|FAIL|unparseable/unauthorized response"); sys.exit()
if d.get("ok"): print("RESULT|rain|OK|rain/health .ok=true (rpc+subgraph)")
else:
    bad=",".join(k for k,v in (d.get("checks") or {}).items() if not (v.get("ok") if isinstance(v,dict) else v)) or "unknown"
    print("RESULT|rain|FAIL|.ok=false checks:"+bad)'
else
  echo "RESULT|rain|UNAVAIL|no gateway token on donor ${KEY_AGENT}"
fi
# Telegram: bot token from openclaw.json channels (any depth), then docker.env.
TG=$(python3 -c "
import json
def find(o):
    if isinstance(o,dict):
        t=o.get('telegram')
        if isinstance(t,dict):
            for k in ('token','botToken','bot_token'):
                if t.get(k): return t[k]
        for v in o.values():
            r=find(v)
            if r: return r
    return None
try: print(find(json.load(open('$A/openclaw.json'))) or '')
except Exception: pass" 2>/dev/null)
[ -n "$TG" ] || TG=$(grep -oE '^[A-Z_]*TELEGRAM[A-Z_]*TOKEN=.*' "$A/docker.env" 2>/dev/null | head -1 | cut -d= -f2-)
if [ -n "$TG" ]; then
  curl -sf --max-time "$TIMEOUT_S" "https://api.telegram.org/bot${TG}/getMe" 2>/dev/null | grep -q '"ok":true' \
    && echo "RESULT|telegram|OK|getMe ok (donor ${KEY_AGENT})" \
    || echo "RESULT|telegram|FAIL|getMe rejected — token invalid or API down"
else
  echo "RESULT|telegram|UNAVAIL|no telegram token on donor ${KEY_AGENT}"
fi
REMOTE
)
[ -n "$donor" ] || { donor="RESULT|rain|UNAVAIL|EU donor unreachable"$'\n'"RESULT|telegram|UNAVAIL|EU donor unreachable"; }
while IFS='|' read -r tag dep verdict note; do
  [ "$tag" = RESULT ] || continue
  case "$verdict" in
    OK)      row "$dep" "Y" "Y" "$note" ;;
    UNAVAIL) row "$dep" "Y" "?" "$note"; iss "ISSUE|P3|deps|$dep|Probe unavailable|$note" ;;
    *)       row "$dep" "Y" "N" "$note"; iss "ISSUE|P1|deps|$dep|Dependency check failed|$note" ;;
  esac
done <<<"$donor"

# 5. OpenRouter — deduped (models check owns it).
row "openrouter" "Y" "n/a" "see MODEL CONNECTIVITY block"

# ── Emit + state files (consumed by the 06:00 diagnostic) ─────────────────────
final="Dependency audit — $(date -u '+%Y-%m-%d %H:%M:%S UTC')
probe: liveness · timeout ${TIMEOUT_S}s · donor ${KEY_AGENT}@${KEY_HOST}

${report}"
printf '%s\n' "$final" | tee "$REPORT_FILE"
printf '%s' "$issues" > "$ISSUES_FILE" 2>/dev/null || true
