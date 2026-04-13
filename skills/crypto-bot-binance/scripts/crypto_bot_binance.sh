#!/usr/bin/env bash
set -euo pipefail

die() { echo "Error: $*" >&2; exit 1; }

require_env() {
  [ -n "${!1:-}" ] || die "Missing env: $1"
}

[[ "${CRYPTO_BOT_BINANCE_BASE_URL:-}" == https://* ]] || die "BASE_URL must be HTTPS"

BASE="${CRYPTO_BOT_BINANCE_BASE_URL%/}"
PREFIX="${CRYPTO_BOT_BINANCE_API_PREFIX:-/api/openclaw}"
PREFIX="${PREFIX%/}"
TIMEOUT="${CRYPTO_BOT_BINANCE_TIMEOUT:-20}"

build_url() {
  local path="$1"
  [[ "$path" == /* ]] || path="/$path"
  echo "${BASE}${PREFIX}${path}"
}

headers=(-H "Accept: application/json")
if [ -n "${CRYPTO_BOT_BINANCE_TOKEN:-}" ]; then
  headers+=(-H "Authorization: Bearer ${CRYPTO_BOT_BINANCE_TOKEN}")
fi

get() {
  curl -fsS "$(build_url "$1")" "${headers[@]}" --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT"
}

post() {
  local path="$1"
  local body="${2:-}"

  if [ -n "$body" ]; then
    curl -fsS -X POST "$(build_url "$path")" "${headers[@]}" -H "Content-Type: application/json" --data "$body" --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT"
  else
    curl -fsS -X POST "$(build_url "$path")" "${headers[@]}" -H "Content-Type: application/json" --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT"
  fi
}

cmd="${1:-}"
shift || true

case "$cmd" in
  health) get "/health" ;;
  status) get "/status" ;;
  balances) get "/balances" ;;
  logs) get "/logs" ;;
  settings) get "/settings" ;;
  open-orders) get "/open-orders" ;;
  executions) get "/executions" ;;
  start) post "/start" ;;
  stop) post "/stop" ;;
  pause) post "/pause" ;;
  resume) post "/resume" ;;
  sync) post "/sync" ;;
  test-connection) post "/test-connection" ;;

  save-settings)
    payload="{"
    first=1

    while [ "$#" -gt 0 ]; do
      [ "$#" -ge 2 ] || die "Missing value for $1"
      key="$1"; val="$2"; shift 2

      [[ "$val" == "true" || "$val" == "false" ]] || die "Invalid bool"

      field="${key/--/}"
      field="${field//-/_}"

      [ "$first" -eq 0 ] && payload+=","
      payload+="\"$field\": $val"
      first=0
    done

    payload+="}"
    post "/save-settings" "$payload"
    ;;

  *) die "Unknown command" ;;
esac
