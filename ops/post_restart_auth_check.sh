#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Post-Restart Auth Check
# Gateway 再起動後に認証トークンの健全性を確認する
# - /health が返るまで待機
# - models status --check で認証状態を検証
# - 問題があれば auth_monitor.py を即座にトリガー
#
# 使い方:
#   ExecStartPost として Gateway systemd service に組み込む
#   または手動: bash ops/post_restart_auth_check.sh

COMPOSE_DIR="/home/ubuntu/openclaw"
HEALTH_URL="http://127.0.0.1:18789/health"
HEALTH_TIMEOUT=5
MAX_WAIT_SECONDS=120
POLL_INTERVAL=3
AUTH_MONITOR="/home/ubuntu/openclaw/ops/auth_monitor.py"
AUTH_MONITOR_ENV="/etc/openclaw/auth-monitor.env"

log() {
  echo "$(date +%FT%T%z) post-restart-auth: $*"
}

# --- Step 1: Gateway が /health を返すまで待機 ---
wait_for_gateway() {
  local elapsed=0
  log "Waiting for Gateway health endpoint..."
  while [ "$elapsed" -lt "$MAX_WAIT_SECONDS" ]; do
    local status
    status=$(curl -sf -o /dev/null -w "%{http_code}" --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" 2>/dev/null) || status="000"
    if [ "$status" = "200" ]; then
      log "Gateway healthy after ${elapsed}s"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  log "ERROR: Gateway did not become healthy within ${MAX_WAIT_SECONDS}s"
  return 1
}

# --- Step 2: models status --check で認証状態を検証 ---
check_auth() {
  log "Running models status --check..."
  local rc
  cd "$COMPOSE_DIR"
  rc=0
  docker compose run --rm openclaw-cli models status --check 2>/dev/null || rc=$?

  case $rc in
    0)
      log "AUTH OK: all tokens valid (rc=0)"
      return 0
      ;;
    2)
      log "AUTH WARNING: tokens expiring within 24h (rc=2)"
      return 2
      ;;
    *)
      log "AUTH ERROR: tokens expired or missing (rc=$rc)"
      return "$rc"
      ;;
  esac
}

# --- Step 3: 問題時 auth_monitor をトリガー ---
trigger_auth_monitor() {
  if [ ! -f "$AUTH_MONITOR" ]; then
    log "auth_monitor.py not found, skipping notification"
    return 0
  fi
  log "Triggering auth monitor for immediate notification..."

  local env_args=()
  if [ -f "$AUTH_MONITOR_ENV" ]; then
    # shellcheck disable=SC2046
    env_args=(env $(grep -v '^#' "$AUTH_MONITOR_ENV" | grep '=' | xargs))
  fi

  "${env_args[@]}" /usr/bin/python3 "$AUTH_MONITOR" --notify-first-run 2>&1 || true
  log "Auth monitor completed"
}

# --- main ---
log "Post-restart auth check starting..."

if ! wait_for_gateway; then
  log "Gateway not ready, cannot check auth"
  exit 1
fi

auth_rc=0
check_auth || auth_rc=$?

if [ "$auth_rc" -ne 0 ]; then
  trigger_auth_monitor
fi

log "Post-restart auth check complete (auth_rc=$auth_rc)"
exit 0
