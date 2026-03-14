#!/usr/bin/env bash
# context-snapshot.sh — Generate a pre-flight context snapshot for coding-agent handoff
# Writes current system state to ~/.openclaw/coding-agent/context/current.json
# Agents call this before escalating to external coding tools — gives full
# situational awareness with zero token cost.
#
# Usage: context-snapshot.sh
#
# Output: JSON status with path to snapshot file

set -eo pipefail

# Resolve OpenClaw state directory
if [ -n "$OPENCLAW_STATE_DIR" ]; then
  BASE="$OPENCLAW_STATE_DIR"
elif [ -d "$HOME/.openclaw" ]; then
  BASE="$HOME/.openclaw"
else
  echo '{"error":"Cannot find OpenClaw state directory. Set OPENCLAW_STATE_DIR or ensure ~/.openclaw exists."}' >&2
  exit 1
fi

OUTDIR="${BASE}/coding-agent/context"
OUTFILE="${OUTDIR}/current.json"
SCRIPTS="${BASE}/scripts"
mkdir -p "$OUTDIR"

# ── Collectors ──
# Each section is optional — gracefully degrades if source doesn't exist

# Model health
MODEL_HEALTH="null"
if [ -f "${BASE}/model-health.json" ]; then
  MODEL_HEALTH=$(jq -c '.' "${BASE}/model-health.json" 2>/dev/null || echo "null")
fi

# Key drift
KEY_DRIFT="null"
if [ -x "${SCRIPTS}/key-drift-check.sh" ]; then
  KEY_DRIFT=$("${SCRIPTS}/key-drift-check.sh" 2>/dev/null || echo '{"status":"ERROR","error":"script failed"}')
fi

# Repo health
REPO_HEALTH="null"
if [ -x "${SCRIPTS}/repo-health.sh" ]; then
  REPO_HEALTH=$("${SCRIPTS}/repo-health.sh" 2>/dev/null || echo '{"status":"ERROR","error":"script failed"}')
fi

# Recent gateway errors (last 5)
RECENT_ERRORS="[]"
if [ -x "${SCRIPTS}/gateway-log-query.sh" ]; then
  RAW_ERRORS=$("${SCRIPTS}/gateway-log-query.sh" --errors --limit 5 2>/dev/null || echo "")
  if [ -n "$RAW_ERRORS" ]; then
    RECENT_ERRORS=$(echo "$RAW_ERRORS" | head -5 | jq -sc '.' 2>/dev/null || echo "[]")
  fi
fi

# Cron status
CRON_STATUS="null"
if [ -f "${BASE}/cron/jobs.json" ]; then
  CRON_STATUS=$(jq -c '[.jobs[] | {name: .name, enabled: .enabled, lastStatus: .state.lastStatus, lastRunAt: (.state.lastRunAtMs // 0 | . / 1000 | strftime("%Y-%m-%dT%H:%M:%SZ")), nextRunAt: (.state.nextRunAtMs // 0 | . / 1000 | strftime("%Y-%m-%dT%H:%M:%SZ"))}]' "${BASE}/cron/jobs.json" 2>/dev/null || echo "null")
fi

# Recent notifications (last 5)
RECENT_NOTIFS="[]"
if [ -f "${BASE}/model-health-notifications.jsonl" ]; then
  RECENT_NOTIFS=$(tail -5 "${BASE}/model-health-notifications.jsonl" 2>/dev/null | jq -sc '.' 2>/dev/null || echo "[]")
fi

# Disk usage
DISK=$(du -sm "${BASE}" 2>/dev/null | awk '{print $1}')

# Active incidents
INCIDENTS="[]"
if [ -x "${SCRIPTS}/incident-manager.sh" ]; then
  RAW_INCIDENTS=$("${SCRIPTS}/incident-manager.sh" list 2>/dev/null || echo "[]")
  INCIDENTS=$(echo "$RAW_INCIDENTS" | jq -c 'if type == "array" then . elif .issues then .issues else [] end' 2>/dev/null || echo "[]")
fi

# Ops database stats (if available)
OPS_DB_STATS="null"
if [ -x "${SCRIPTS}/ops-db.sh" ]; then
  OPS_DB_STATS=$("${SCRIPTS}/ops-db.sh" stats 2>/dev/null | jq -c '.' 2>/dev/null || echo "null")
fi

# Build snapshot
jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson modelHealth "$MODEL_HEALTH" \
  --argjson keyDrift "$KEY_DRIFT" \
  --argjson repoHealth "$REPO_HEALTH" \
  --argjson recentErrors "$RECENT_ERRORS" \
  --argjson cronStatus "$CRON_STATUS" \
  --argjson recentNotifs "$RECENT_NOTIFS" \
  --argjson incidents "$INCIDENTS" \
  --argjson opsDbStats "$OPS_DB_STATS" \
  --arg diskMB "$DISK" \
  '{
    timestamp: $ts,
    modelHealth: $modelHealth,
    keyDrift: $keyDrift,
    repoHealth: $repoHealth,
    recentErrors: $recentErrors,
    cronStatus: $cronStatus,
    recentNotifications: $recentNotifs,
    activeIncidents: $incidents,
    opsDbStats: $opsDbStats,
    diskUsageMB: ($diskMB | tonumber)
  }' > "$OUTFILE"

echo "{\"status\":\"ok\",\"path\":\"${OUTFILE}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
