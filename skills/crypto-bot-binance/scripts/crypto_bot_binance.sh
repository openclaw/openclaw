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

curl_cfg_escape() {
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

basic_user="${CRYPTO_BOT_BINANCE_BASIC_AUTH_USER:-}"
basic_pass="${CRYPTO_BOT_BINANCE_BASIC_AUTH_PASSWORD:-}"
if [ -n "$basic_user" ] || [ -n "$basic_pass" ]; then
  [ -n "$basic_user" ] && [ -n "$basic_pass" ] || die "Both CRYPTO_BOT_BINANCE_BASIC_AUTH_USER and CRYPTO_BOT_BINANCE_BASIC_AUTH_PASSWORD are required for Basic Auth"
fi

run_curl_config() {
  local cfg_file="$1"
  local status=0
  curl --config "$cfg_file" || status=$?
  rm -f "$cfg_file"
  return "$status"
}

write_common_config() {
  local cfg_file="$1"
  local url="$2"
  local include_retry="$3"

  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'fail\n'
    printf 'connect-timeout = "%s"\n' "$(curl_cfg_escape "$TIMEOUT")"
    printf 'max-time = "%s"\n' "$(curl_cfg_escape "$TIMEOUT")"
    if [ "$include_retry" = "true" ] && [ "$RETRIES" -gt 0 ]; then
      printf 'retry = "%s"\n' "$(curl_cfg_escape "$RETRIES")"
    fi
    printf 'url = "%s"\n' "$(curl_cfg_escape "$url")"
    printf 'header = "%s"\n' "$(curl_cfg_escape "Accept: application/json")"

    if [ -n "${CRYPTO_BOT_BINANCE_TOKEN:-}" ]; then
      printf 'header = "%s"\n' "$(curl_cfg_escape "Authorization: Bearer ${CRYPTO_BOT_BINANCE_TOKEN}")"
    fi

    if [ -n "${CRYPTO_BOT_BINANCE_X_OPENCLAW_TOKEN:-}" ]; then
      printf 'header = "%s"\n' "$(curl_cfg_escape "X-OpenClaw-Token: ${CRYPTO_BOT_BINANCE_X_OPENCLAW_TOKEN}")"
    fi

    if [ -n "$basic_user" ]; then
      printf 'user = "%s"\n' "$(curl_cfg_escape "${basic_user}:${basic_pass}")"
    fi
  } > "$cfg_file"
}

get() {
  local cfg_file
  cfg_file="$(mktemp)"
  write_common_config "$cfg_file" "$(build_url "$1")" "true"
  run_curl_config "$cfg_file"
}

post() {
  local path="$1"
  local body="${2:-}"
  local cfg_file
  cfg_file="$(mktemp)"

  write_common_config "$cfg_file" "$(build_url "$path")" "false"

  {
    printf 'request = "%s"\n' "$(curl_cfg_escape "POST")"
    printf 'header = "%s"\n' "$(curl_cfg_escape "Content-Type: application/json")"
    if [ -n "$body" ]; then
      printf 'data = "%s"\n' "$(curl_cfg_escape "$body")"
    fi
  } >> "$cfg_file"

  run_curl_config "$cfg_file"
}

require_safe_save_flag() {
  case "$1" in
    --integration-enabled|--remote-control-enabled|--monitoring-enabled|--ui-badge-enabled) ;;
    *) die "Unsupported save-settings flag: $1" ;;
  esac
}

require_boolean() {
  local key="$1"
  local value="$2"
  [[ "$value" == "true" || "$value" == "false" ]] || die "Invalid boolean for $key: $value (expected true/false)"
}

normalize_save_field() {
  local key="$1"
  key="${key#--}"
  key="${key//-/_}"
  printf '%s' "$key"
}

parse_test_connection_args() {
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
  test-connection) parse_test_connection_args "$@" ;;

  save-settings)
    [ "$#" -gt 0 ] || die "save-settings requires at least one supported flag"

    payload="{"
    first=1

    while [ "$#" -gt 0 ]; do
      [ "$#" -ge 2 ] || die "Missing value for $1"
      key="$1"
      val="$2"
      shift 2

      require_safe_save_flag "$key"
      require_boolean "$key" "$val"

      field="$(normalize_save_field "$key")"

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
