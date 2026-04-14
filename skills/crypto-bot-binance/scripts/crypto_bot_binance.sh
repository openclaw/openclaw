#!/usr/bin/env bash
set -euo pipefail

die() { echo "Error: $*" >&2; exit 1; }

require_env() {
  [ -n "${!1:-}" ] || die "Missing env: $1"
}

require_env "CRYPTO_BOT_BINANCE_BASE_URL"
[[ "${CRYPTO_BOT_BINANCE_BASE_URL}" =~ ^https:// ]] || die "CRYPTO_BOT_BINANCE_BASE_URL must start with https://"

BASE="${CRYPTO_BOT_BINANCE_BASE_URL%/}"

normalize_prefix() {
  local prefix="${1:-/api/openclaw}"
  prefix="${prefix%/}"
  if [ -n "$prefix" ] && [[ "$prefix" != /* ]]; then
    prefix="/$prefix"
  fi
  [ "$prefix" = "/" ] && prefix=""
  echo "$prefix"
}

PREFIX="$(normalize_prefix "${CRYPTO_BOT_BINANCE_API_PREFIX:-/api/openclaw}")"
TIMEOUT="${CRYPTO_BOT_BINANCE_TIMEOUT:-25}"
RETRIES="${CRYPTO_BOT_BINANCE_RETRIES:-1}"

[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || die "CRYPTO_BOT_BINANCE_TIMEOUT must be an integer"
[[ "$RETRIES" =~ ^[0-9]+$ ]] || die "CRYPTO_BOT_BINANCE_RETRIES must be an integer"

json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

build_url() {
  local path="$1"
  [[ "$path" == /* ]] || path="/$path"
  echo "${BASE}${PREFIX}${path}"
}

headers=(-H "Accept: application/json")
curl_opts=(--connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" --retry "$RETRIES")

if [ -n "${CRYPTO_BOT_BINANCE_TOKEN:-}" ]; then
  headers+=(-H "Authorization: Bearer ${CRYPTO_BOT_BINANCE_TOKEN}")
fi

if [ -n "${CRYPTO_BOT_BINANCE_X_OPENCLAW_TOKEN:-}" ]; then
  headers+=(-H "X-OpenClaw-Token: ${CRYPTO_BOT_BINANCE_X_OPENCLAW_TOKEN}")
fi

basic_user="${CRYPTO_BOT_BINANCE_BASIC_AUTH_USER:-}"
basic_pass="${CRYPTO_BOT_BINANCE_BASIC_AUTH_PASSWORD:-}"
if [ -n "$basic_user" ] || [ -n "$basic_pass" ]; then
  [ -n "$basic_user" ] && [ -n "$basic_pass" ] || die "Both CRYPTO_BOT_BINANCE_BASIC_AUTH_USER and CRYPTO_BOT_BINANCE_BASIC_AUTH_PASSWORD are required for Basic Auth"
  [ -z "${CRYPTO_BOT_BINANCE_TOKEN:-}" ] || die "Set either CRYPTO_BOT_BINANCE_TOKEN or Basic Auth credentials, not both"
  curl_opts+=(-u "${basic_user}:${basic_pass}")
fi

get() {
  curl -fsS "$(build_url "$1")" "${headers[@]}" "${curl_opts[@]}"
}

post() {
  local path="$1"
  local body="${2:-}"

  if [ -n "$body" ]; then
    curl -fsS -X POST "$(build_url "$path")" "${headers[@]}" "${curl_opts[@]}" -H "Content-Type: application/json" --data "$body"
  else
    curl -fsS -X POST "$(build_url "$path")" "${headers[@]}" "${curl_opts[@]}" -H "Content-Type: application/json"
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
  test-connection)
    api_key=""
    api_secret=""

    while [ "$#" -gt 0 ]; do
      case "$1" in
        --api-key)
          [ "$#" -ge 2 ] || die "Missing value for --api-key"
          api_key="$2"
          shift 2
          ;;
        --api-secret)
          [ "$#" -ge 2 ] || die "Missing value for --api-secret"
          api_secret="$2"
          shift 2
          ;;
        *)
          die "Unknown flag for test-connection: $1"
          ;;
      esac
    done

    if [ -n "$api_key" ] || [ -n "$api_secret" ]; then
      [ -n "$api_key" ] && [ -n "$api_secret" ] || die "Provide both --api-key and --api-secret together"
      post "/test-connection" "{\"api_key\":\"$(json_escape "$api_key")\",\"api_secret\":\"$(json_escape "$api_secret")\"}"
    else
      post "/test-connection"
    fi
    ;;

  save-settings)
    [ "$#" -gt 0 ] || die "save-settings requires at least one supported flag"

    payload="{"
    first=1

    while [ "$#" -gt 0 ]; do
      [ "$#" -ge 2 ] || die "Missing value for $1"
      key="$1"
      val="$2"
      shift 2

      case "$key" in
        --integration-enabled|--remote-control-enabled|--monitoring-enabled|--ui-badge-enabled) ;;
        *) die "Unsupported save-settings flag: $key" ;;
      esac

      [[ "$val" == "true" || "$val" == "false" ]] || die "Invalid boolean for $key: $val (expected true/false)"

      field="${key#--}"
      field="${field//-/_}"

      [ "$first" -eq 0 ] && payload+=","
      payload+="\"$field\": $val"
      first=0
    done

    [ "$first" -eq 0 ] || die "save-settings requires at least one supported flag"

    payload+="}"
    post "/save-settings" "$payload"
    ;;

  "")
    die "Missing command"
    ;;

  *)
    die "Unknown command: $cmd"
    ;;
esac
