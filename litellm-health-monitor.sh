#!/usr/bin/env bash
# LiteLLM health-monitor for OpenClaw.
# Checks the gateway liveliness; on failure attempts an idempotent auto-restart
# and alerts the owner over the existing Telegram bot (no new token, no polling
# conflict — delivery goes through `openclaw message send`).
#
# State machine (no spam): alert once on up->down and once on down->up; a blip
# that self-heals via auto-restart sends a single "recovered" note.
#
# Run by systemd --user timer every 2 min. Safe to run manually.
set -uo pipefail

export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$PNPM_HOME:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$REPO_DIR/docker-compose.litellm.yml"
LIVELINESS_URL="${LITELLM_LIVELINESS_URL:-http://127.0.0.1:4000/health/liveliness}"
STATE_FILE="${LITELLM_MONITOR_STATE:-$HOME/.openclaw/.litellm-monitor-state}"
LOG_FILE="${LITELLM_MONITOR_LOG:-$HOME/.openclaw/litellm-monitor.log}"
TG_CHANNEL="telegram"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG_FILE" 2>/dev/null; }

# Resolve the owner Telegram target at runtime (first user peer). No chat id is
# stored on disk. Override with MONITOR_TARGET if you ever need a fixed target.
resolve_target() {
  if [ -n "${MONITOR_TARGET:-}" ]; then printf '%s' "$MONITOR_TARGET"; return; fi
  timeout 25 openclaw directory peers list --channel "$TG_CHANNEL" --json 2>/dev/null \
   | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit()
items=d if isinstance(d,list) else d.get('peers',d.get('items',[]))
for p in (items or []):
    if isinstance(p,dict) and (p.get('kind')=='user' or 'id' in p):
        print(p.get('id') or p.get('chatId') or ''); break
" 2>/dev/null
}

send_tg() {
  local msg="$1" target
  target="$(resolve_target)"
  if [ -z "$target" ]; then log "ALERT-DELIVERY-FAIL: no telegram target resolved | msg=$msg"; return 1; fi
  if timeout 40 openclaw message send --channel "$TG_CHANNEL" --target "$target" --message "$msg" >/dev/null 2>&1; then
    log "ALERT-SENT: $msg"
  else
    log "ALERT-DELIVERY-FAIL (message send): $msg"
  fi
}

is_alive() {
  local code
  for _ in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$LIVELINESS_URL" 2>/dev/null)
    [ "$code" = "200" ] && return 0
    sleep 2
  done
  return 1
}

attempt_restart() {
  log "AUTO-RESTART: docker compose up -d"
  ( cd "$REPO_DIR" && docker compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1 ) || log "AUTO-RESTART: compose command failed"
  for _ in $(seq 1 10); do is_alive && return 0; sleep 3; done
  return 1
}

PREV="up"; [ -f "$STATE_FILE" ] && PREV="$(cat "$STATE_FILE" 2>/dev/null || echo up)"
NOW_TS="$(date '+%Y-%m-%d %H:%M')"

if is_alive; then
  if [ "$PREV" = "down" ]; then
    send_tg "✅ LiteLLM снова доступен ($NOW_TS). Аварийный fallback-маршрут OpenClaw восстановлен (127.0.0.1:4000)."
  fi
  echo up >"$STATE_FILE"; log "OK: liveliness 200 (prev=$PREV)"
  exit 0
fi

# unhealthy now
log "DOWN: liveliness != 200 (prev=$PREV) — attempting auto-restart"
if attempt_restart; then
  if [ "$PREV" = "up" ]; then
    send_tg "⚠️ LiteLLM падал ($NOW_TS), но восстановлен авто-рестартом. Fallback-маршрут снова жив. Стоит глянуть логи: docker logs openclaw-litellm"
  else
    send_tg "✅ LiteLLM восстановлен авто-рестартом ($NOW_TS)."
  fi
  echo up >"$STATE_FILE"; log "RECOVERED via auto-restart"
  exit 0
fi

# still down after restart
if [ "$PREV" != "down" ]; then
  send_tg "🔴 LiteLLM DOWN ($NOW_TS) — авто-рестарт НЕ помог. Аварийный fallback OpenClaw недоступен (Claude-only агенты держатся только на подписке). Нужен ручной разбор: docker logs openclaw-litellm ; docker compose -f $COMPOSE_FILE up -d"
fi
echo down >"$STATE_FILE"; log "STILL DOWN after auto-restart"
exit 1
