#!/usr/bin/env bash
set -euo pipefail

GATEWAY_PORT="${GATEWAY_HOST_PORT:-8000}"
BASE_URL="${GESAHNI_BASE_URL:-http://127.0.0.1:${GATEWAY_PORT}}"
BRIDGE_TOKEN="${GESAHNI_READ_BRIDGE_TOKEN:-}"
CHAT_ID="${GESAHNI_TEST_CHAT_ID:-}"

if [[ -z "$BRIDGE_TOKEN" ]]; then
  echo "FAIL missing GESAHNI_READ_BRIDGE_TOKEN"
  exit 1
fi

if [[ -z "$CHAT_ID" ]]; then
  echo "FAIL missing GESAHNI_TEST_CHAT_ID"
  exit 1
fi

USER_ID="tg:${CHAT_ID}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass_count=0
fail_count=0
skip_count=0

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL missing jq"
  exit 1
fi

check_get() {
  local name="$1"
  local url="$2"
  local body_file="$TMP_DIR/${name}.json"
  local status=0
  if ! curl -fsS "$url" >"$body_file"; then
    status=1
  fi
  if [[ "$status" -eq 0 ]]; then
    echo "PASS ${name}"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL ${name}"
    fail_count=$((fail_count + 1))
  fi
}

check_bridge_get() {
  local name="$1"
  local path="$2"
  local body_file="$TMP_DIR/${name}.json"
  local status=0
  if ! curl -fsS \
    -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
    -H "X-User-Id: ${USER_ID}" \
    "${BASE_URL}${path}" >"$body_file"; then
    status=1
  fi
  if [[ "$status" -eq 0 ]]; then
    echo "PASS ${name}"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL ${name}"
    fail_count=$((fail_count + 1))
  fi
}

skip_check() {
  local name="$1"
  local reason="$2"
  echo "SKIP ${name} (${reason})"
  skip_count=$((skip_count + 1))
}

check_get "health" "${BASE_URL}/health"
check_bridge_get "bridge_watchlist" "/v1/bridge/watchlist"
check_bridge_get "bridge_positions" "/v1/bridge/positions"
check_bridge_get "bridge_market_summary" "/v1/bridge/market/summary"
check_bridge_get "bridge_alerts" "/v1/bridge/alerts"
check_bridge_get "bridge_earnings_upcoming" "/v1/bridge/earnings/upcoming?days=14"
check_bridge_get "bridge_portfolio" "/v1/bridge/portfolio"
check_bridge_get "bridge_options_positions" "/v1/bridge/options/positions"
check_bridge_get "bridge_options_watch_rules" "/v1/bridge/options/watch_rules"
check_bridge_get "bridge_options_status" "/v1/bridge/options/status"
check_bridge_get "bridge_options_alert_suggestions" "/v1/bridge/options/alert_suggestions"
check_bridge_get "bridge_options_chain_snapshot" "/v1/bridge/options/chain_snapshot?symbol=AAPL"
check_bridge_get "bridge_options_quotes_batch" "/v1/bridge/options/quotes_batch?symbols=AAPL,MSFT"
check_bridge_get "bridge_earnings_coverage" "/v1/bridge/earnings/coverage"
check_bridge_get "bridge_earnings_reminders_due" "/v1/bridge/earnings/reminders/due"
check_bridge_get "bridge_earnings_reminders_sent" "/v1/bridge/earnings/reminders/sent"

ALERT_ID="$(jq -r '.alerts[0].id // empty' "$TMP_DIR/bridge_alerts.json" 2>/dev/null || true)"
if [[ -n "$ALERT_ID" ]]; then
  check_bridge_get "bridge_alert_deliveries" "/v1/bridge/alerts/${ALERT_ID}/deliveries"
else
  skip_check "bridge_alert_deliveries" "no alerts available"
fi

WATCH_RULE_ID="$(jq -r '.watch_rules[0].id // empty' "$TMP_DIR/bridge_options_watch_rules.json" 2>/dev/null || true)"
if [[ -n "$WATCH_RULE_ID" ]]; then
  check_bridge_get "bridge_options_watch_rule_events" "/v1/bridge/options/watch_rules/${WATCH_RULE_ID}/events"
else
  skip_check "bridge_options_watch_rule_events" "no watch rules available"
fi

echo "Summary: PASS=${pass_count} FAIL=${fail_count} SKIP=${skip_count}"
if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi
