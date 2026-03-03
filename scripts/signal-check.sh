#!/usr/bin/env bash
# signal-check.sh — quick Signal channel health diagnostic
# Usage: bash scripts/signal-check.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.safe"

# Safe env reader — grep-based so paths with spaces in .env.safe don't break bash
get_env() {
  local key="$1" default="${2:-}"
  local val
  val=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  echo "${val:-$default}"
}

SIGNAL_CLI_DATA_DIR=$(get_env SIGNAL_CLI_DATA_DIR "/Volumes/Crucial Deez X9 Pro/openclaw_safe_live/config/signal-cli")
SIGNAL_CLI_PORT_HOST=$(get_env SIGNAL_CLI_PORT "127.0.0.1:18080")
HTTP_PORT="${SIGNAL_CLI_PORT_HOST##*:}"
HTTP_HOST="${SIGNAL_CLI_PORT_HOST%%:*}"

OK=0; FAIL=0
ok()   { echo "  ✅ $*"; OK=$((OK+1)); }
fail() { echo "  ❌ $*"; FAIL=$((FAIL+1)); }
info() { echo "  ℹ  $*"; }

echo ""
echo "━━━ Signal Channel Health ━━━"
echo ""

# 1. Container running?
echo "[ Container ]"
CSTATUS=$(docker inspect openclaw-signal --format '{{.State.Status}}' 2>/dev/null || echo "missing")
if [ "$CSTATUS" = "running" ]; then
  ok "openclaw-signal is running"
else
  fail "openclaw-signal is ${CSTATUS} — run: docker compose --env-file .env.safe up -d signal-cli"
fi

# 2. JAVA_TOOL_OPTIONS set? (mandatory — prevents SIGBUS on ARM64/external SSD)
echo ""
echo "[ JAVA_TOOL_OPTIONS — SQLite SIGBUS guard ]"
JTO=$(docker inspect openclaw-signal --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | grep '^JAVA_TOOL_OPTIONS=' || echo "")
if echo "$JTO" | grep -q 'exportPath=/tmp'; then
  ok "$JTO"
else
  fail "JAVA_TOOL_OPTIONS not set or missing exportPath=/tmp"
  fail "SQLite WILL crash with SIGBUS on ARM64 with external SSD — messages silently dropped"
fi

# 3. Account linked?
echo ""
echo "[ Account data ]"
ACCOUNTS_JSON="${SIGNAL_CLI_DATA_DIR}/data/accounts.json"
DB=$(find "${SIGNAL_CLI_DATA_DIR}/data" -name 'account.db' -maxdepth 2 2>/dev/null | head -1 || true)
if [ -n "$DB" ]; then
  ok "account.db found: ${DB}"
  if [ -f "$ACCOUNTS_JSON" ]; then
    ACCT_NUM=$(grep -o '"number" : "[^"]*"' "$ACCOUNTS_JSON" 2>/dev/null || echo "unknown")
    info "Account: ${ACCT_NUM}"
  fi
else
  fail "No account.db — device not linked"
  fail "Fix: bash scripts/signal-relink.sh"
fi

# 4. HTTP/SSE endpoint? — Python reads response headers only (curl would hang on SSE stream)
echo ""
echo "[ HTTP endpoint ]"
HTTP_OK=$(python3 -c "
import urllib.request, sys
try:
    r = urllib.request.urlopen(
        'http://${HTTP_HOST}:${HTTP_PORT}/api/v1/events', timeout=3)
    print('200' if r.status == 200 else str(r.status))
except Exception as e:
    print('ERR:' + str(e))
" 2>/dev/null || echo "ERR:exception")
if [ "$HTTP_OK" = "200" ]; then
  ok "SSE endpoint → 200 (http://${HTTP_HOST}:${HTTP_PORT}/api/v1/events)"
else
  fail "SSE endpoint returned ${HTTP_OK} (expected 200)"
fi

# 5. Gateway log check (grep -c returns exit 1 on zero matches; use subshell with || true)
echo ""
echo "[ Gateway ]"
RECENT_ERRORS=$(docker logs --since 60s openclaw-openclaw-gateway-1 2>/dev/null \
  | (grep -c 'SSE stream error' || true))
if [ "${RECENT_ERRORS:-0}" = "0" ]; then
  ok "No SSE stream errors in last 60s"
else
  fail "${RECENT_ERRORS} SSE stream errors in last 60s — may indicate signal-cli is crashing"
fi
RECENT_ACTIVITY=$(docker logs --since 300s openclaw-openclaw-gateway-1 2>/dev/null \
  | (grep -c 'signal\|delivered reply' || true))
info "Signal log entries in last 5m: ${RECENT_ACTIVITY:-0}"

# 6. Backup age
echo ""
echo "[ Account backup ]"
BACKUP_DIR="${HOME}/.maxbot/signal-backup"
BACKUP_JSON="${BACKUP_DIR}/data/accounts.json"
if [ -f "$BACKUP_JSON" ]; then
  BACKUP_MTIME=$(stat -f %m "$BACKUP_JSON" 2>/dev/null || echo 0)
  BACKUP_AGE=$(( ( $(date +%s) - BACKUP_MTIME ) / 3600 ))
  ok "Backup at ${BACKUP_DIR} (${BACKUP_AGE}h old)"
  if [ "$BACKUP_AGE" -gt 168 ]; then
    info "Backup is >7 days old — run: bash scripts/signal-backup.sh"
  fi
else
  fail "No backup at ${BACKUP_DIR} — run: bash scripts/signal-backup.sh"
fi

echo ""
echo "━━━ ${OK} OK · ${FAIL} failed ━━━"
echo ""
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
