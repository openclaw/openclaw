#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  crypto_bot_binance.sh <command> [options]

Commands:
  health
  status
  balances
  logs
  settings
  open-orders
  executions
  start
  stop
  pause
  resume
  sync
  test-connection
  save-settings [--integration-enabled true|false] [--remote-control-enabled true|false] [--monitoring-enabled true|false] [--ui-badge-enabled true|false]

Environment:
  CRYPTO_BOT_BINANCE_BASE_URL   Required (example: https://bot.adduser.xyz)
  CRYPTO_BOT_BINANCE_API_PREFIX Optional endpoint prefix, default: /api/openclaw
  CRYPTO_BOT_BINANCE_TOKEN      Optional, sent as X-OpenClaw-Token when set
  CRYPTO_BOT_BINANCE_BASIC_USER Optional, for HTTP Basic Auth at reverse proxy
  CRYPTO_BOT_BINANCE_BASIC_PASS Optional, for HTTP Basic Auth at reverse proxy
  CRYPTO_BOT_BINANCE_TIMEOUT    Optional seconds, default: 25
  CRYPTO_BOT_BINANCE_RETRIES    Optional retries, default: 1

Examples:
  crypto_bot_binance.sh health
  crypto_bot_binance.sh status
  crypto_bot_binance.sh start
  crypto_bot_binance.sh save-settings --integration-enabled true --remote-control-enabled true --monitoring-enabled true --ui-badge-enabled true
USAGE
  exit 2
}

err() {
  echo "error: $*" >&2
  exit 1
}

require_bool() {
  local name="$1"
  local value="$2"
  case "$value" in
    true|false) ;;
    *) err "${name} must be true or false (got: ${value})" ;;
  esac
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

command="$1"
shift || true

base_url="${CRYPTO_BOT_BINANCE_BASE_URL:-}"
[[ -n "$base_url" ]] || err "CRYPTO_BOT_BINANCE_BASE_URL is required"
base_url="${base_url%/}"
api_prefix="${CRYPTO_BOT_BINANCE_API_PREFIX:-/api/openclaw}"
api_prefix="/${api_prefix#/}"
api_prefix="${api_prefix%/}"

token="${CRYPTO_BOT_BINANCE_TOKEN:-}"
basic_user="${CRYPTO_BOT_BINANCE_BASIC_USER:-}"
basic_pass="${CRYPTO_BOT_BINANCE_BASIC_PASS:-}"
timeout="${CRYPTO_BOT_BINANCE_TIMEOUT:-25}"
retries="${CRYPTO_BOT_BINANCE_RETRIES:-1}"

if [[ -n "$basic_user" && -z "$basic_pass" ]]; then
  err "CRYPTO_BOT_BINANCE_BASIC_PASS is required when CRYPTO_BOT_BINANCE_BASIC_USER is set"
fi
if [[ -z "$basic_user" && -n "$basic_pass" ]]; then
  err "CRYPTO_BOT_BINANCE_BASIC_USER is required when CRYPTO_BOT_BINANCE_BASIC_PASS is set"
fi

method="GET"
path=""
body=""

case "$command" in
  health) path="${api_prefix}/health" ;;
  status) path="${api_prefix}/status" ;;
  balances) path="${api_prefix}/balances" ;;
  logs) path="${api_prefix}/logs" ;;
  settings) path="${api_prefix}/settings" ;;
  open-orders) path="${api_prefix}/open-orders" ;;
  executions) path="${api_prefix}/executions" ;;
  start) method="POST"; path="${api_prefix}/start" ;;
  stop) method="POST"; path="${api_prefix}/stop" ;;
  pause) method="POST"; path="${api_prefix}/pause" ;;
  resume) method="POST"; path="${api_prefix}/resume" ;;
  sync) method="POST"; path="${api_prefix}/sync" ;;
  test-connection) method="POST"; path="${api_prefix}/test-connection" ;;
  save-settings)
    method="POST"
    path="${api_prefix}/save-settings"

    integration_enabled="true"
    remote_control_enabled="true"
    monitoring_enabled="true"
    ui_badge_enabled="true"

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --integration-enabled)
          [[ $# -ge 2 ]] || err "--integration-enabled requires a value"
          integration_enabled="$2"
          shift 2
          ;;
        --remote-control-enabled)
          [[ $# -ge 2 ]] || err "--remote-control-enabled requires a value"
          remote_control_enabled="$2"
          shift 2
          ;;
        --monitoring-enabled)
          [[ $# -ge 2 ]] || err "--monitoring-enabled requires a value"
          monitoring_enabled="$2"
          shift 2
          ;;
        --ui-badge-enabled)
          [[ $# -ge 2 ]] || err "--ui-badge-enabled requires a value"
          ui_badge_enabled="$2"
          shift 2
          ;;
        *)
          err "unknown save-settings option: $1"
          ;;
      esac
    done

    require_bool "integration-enabled" "$integration_enabled"
    require_bool "remote-control-enabled" "$remote_control_enabled"
    require_bool "monitoring-enabled" "$monitoring_enabled"
    require_bool "ui-badge-enabled" "$ui_badge_enabled"

    body=$(cat <<JSON
{"integration_enabled":${integration_enabled},"remote_control_enabled":${remote_control_enabled},"monitoring_enabled":${monitoring_enabled},"ui_badge_enabled":${ui_badge_enabled}}
JSON
)
    ;;
  *)
    err "unknown command: ${command}"
    ;;
esac

if [[ $# -gt 0 ]]; then
  err "unexpected arguments for command '${command}': $*"
fi

url="${base_url}${path}"

tmp_body="$(mktemp)"
cleanup() {
  rm -f "$tmp_body"
}
trap cleanup EXIT

curl_args=(
  -sS
  -X "$method"
  "$url"
  -H "Accept: application/json"
  --connect-timeout "$timeout"
  --max-time "$timeout"
  --retry "$retries"
  --retry-delay 1
  --retry-all-errors
  -o "$tmp_body"
  -w "%{http_code}"
)

if [[ -n "$token" ]]; then
  curl_args+=( -H "X-OpenClaw-Token: ${token}" )
fi

if [[ -n "$basic_user" ]]; then
  curl_args+=( -u "${basic_user}:${basic_pass}" )
fi

if [[ -n "$body" ]]; then
  curl_args+=( -H "Content-Type: application/json" --data "$body" )
fi

http_code="$(curl "${curl_args[@]}")"

if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
  response="$(cat "$tmp_body")"
  [[ -n "$response" ]] || response="(empty response body)"
  err "HTTP ${http_code} for ${method} ${path}: ${response}"
fi

cat "$tmp_body"
echo
