#!/usr/bin/env bash
set -euo pipefail

WIZ_API_URL="${WIZ_API_URL:-https://api.eu26.app.wiz.io/graphql}"
WIZ_AUTH_URL="${WIZ_AUTH_URL:-https://auth.app.wiz.io/oauth/token}"
WIZ_API_TOKEN_CACHE="${WIZ_API_TOKEN_CACHE:-/tmp/wiz-api-token.json}"
WIZ_API_MAX_PAGES="${WIZ_API_MAX_PAGES:-10}"
WIZ_API_TIMEOUT="${WIZ_API_TIMEOUT:-30}"
WIZ_API_CURL_BIN="${WIZ_API_CURL_BIN:-curl}"
WIZ_API_JQ_BIN="${WIZ_API_JQ_BIN:-jq}"
WIZ_API_SKIP_VAULT="${WIZ_API_SKIP_VAULT:-0}"
WIZ_API_VAULT_SECRET_PATH="${WIZ_API_VAULT_SECRET_PATH:-secret/data/wiz/api-token}"

WIZ_API_ACTIVE_CLIENT_ID=""
WIZ_API_ACTIVE_CLIENT_SECRET=""
WIZ_API_CREDENTIAL_SOURCE=""
WIZ_API_BEARER_TOKEN=""

die() {
  printf 'wiz-api: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "missing command: ${cmd}"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

detect_service_account_jwt() {
  local jwt_file="${WIZ_API_VAULT_JWT_FILE:-/var/run/secrets/kubernetes.io/serviceaccount/token}"
  [[ -f "$jwt_file" ]] || return 1
  [[ -s "$jwt_file" ]] || return 1
  printf '%s\n' "$jwt_file"
}

load_credentials_from_vault() {
  local vault_addr="${VAULT_ADDR:-}"
  local auth_path="${VAULT_KUBERNETES_AUTH_PATH:-kubernetes}"
  local role="${VAULT_KUBERNETES_ROLE:-incident-readonly-agent}"
  local secret_path="$WIZ_API_VAULT_SECRET_PATH"
  local jwt_file jwt login_payload login_json vault_token secret_json

  [[ -n "$vault_addr" ]] || return 1
  jwt_file="$(detect_service_account_jwt)" || return 1
  jwt="$(tr -d '\r\n' <"$jwt_file")"
  [[ -n "$jwt" ]] || return 1

  has_cmd "$WIZ_API_CURL_BIN" || return 1
  has_cmd "$WIZ_API_JQ_BIN" || return 1

  login_payload="$("$WIZ_API_JQ_BIN" -nc --arg role "$role" --arg jwt "$jwt" '{role:$role,jwt:$jwt}')"
  login_json="$(
    "$WIZ_API_CURL_BIN" -fsS \
      -H 'Content-Type: application/json' \
      --data "$login_payload" \
      "${vault_addr%/}/v1/auth/${auth_path}/login"
  )" || return 1

  vault_token="$(printf '%s\n' "$login_json" | "$WIZ_API_JQ_BIN" -r '.auth.client_token // empty')"
  [[ -n "$vault_token" ]] || return 1

  secret_json="$(
    "$WIZ_API_CURL_BIN" -fsS \
      -H "X-Vault-Token: ${vault_token}" \
      "${vault_addr%/}/v1/${secret_path}"
  )" || return 1

  WIZ_API_ACTIVE_CLIENT_ID="$(printf '%s\n' "$secret_json" | "$WIZ_API_JQ_BIN" -r '.data.data.client_id // empty')"
  WIZ_API_ACTIVE_CLIENT_SECRET="$(printf '%s\n' "$secret_json" | "$WIZ_API_JQ_BIN" -r '.data.data.client_secret // .data.data.client_token // empty')"
  [[ -n "$WIZ_API_ACTIVE_CLIENT_ID" && -n "$WIZ_API_ACTIVE_CLIENT_SECRET" ]] || return 1

  WIZ_API_CREDENTIAL_SOURCE="vault:${secret_path}"
  return 0
}

load_credentials_from_env() {
  local client_id="${WIZ_CLIENT_ID:-}"
  local client_secret="${WIZ_CLIENT_SECRET:-}"
  if [[ -z "$client_id" || -z "$client_secret" ]]; then
    return 1
  fi
  WIZ_API_ACTIVE_CLIENT_ID="$client_id"
  WIZ_API_ACTIVE_CLIENT_SECRET="$client_secret"
  WIZ_API_CREDENTIAL_SOURCE="env"
  return 0
}

load_credentials() {
  if [[ "$WIZ_API_SKIP_VAULT" != "1" ]] && load_credentials_from_vault; then
    return 0
  fi
  if load_credentials_from_env; then
    return 0
  fi
  die "missing Wiz credentials; tried Vault ${WIZ_API_VAULT_SECRET_PATH} and WIZ_CLIENT_ID/WIZ_CLIENT_SECRET"
}

cmd_print_plan() {
  "$WIZ_API_JQ_BIN" -nc \
    --arg apiUrl "$WIZ_API_URL" \
    --arg authUrl "$WIZ_AUTH_URL" \
    --arg tokenCache "$WIZ_API_TOKEN_CACHE" \
    --arg credentialSource "$WIZ_API_CREDENTIAL_SOURCE" \
    --argjson maxPages "$WIZ_API_MAX_PAGES" \
    --argjson timeout "$WIZ_API_TIMEOUT" \
    '{
      apiUrl: $apiUrl,
      authUrl: $authUrl,
      tokenCache: $tokenCache,
      credentialSource: $credentialSource,
      maxPages: $maxPages,
      timeout: $timeout
    }'
}

usage() {
  cat <<'EOF'
Usage:
  wiz-api.sh --probe-auth
  wiz-api.sh --print-plan
  wiz-api.sh query '<graphql>' ['<variables_json>']
  wiz-api.sh query @<file.graphql> ['<variables_json>']
  wiz-api.sh vulns [--severity S] [--image I] [--cve C] [--has-fix] [--first N] [--max-pages N]
  wiz-api.sh issues [--severity S] [--status S] [--type T] [--entity-type E] [--first N] [--max-pages N]
  wiz-api.sh inventory [--type T] [--subscription S] [--search Q] [--first N] [--max-pages N]
  wiz-api.sh cloud-config [--severity S] [--rule R] [--status S] [--first N] [--max-pages N]
  wiz-api.sh k8s [--cluster C] [--first N] [--max-pages N]
  wiz-api.sh runtime [--severity S] [--first N] [--max-pages N]
  wiz-api.sh summary

Env:
  WIZ_CLIENT_ID, WIZ_CLIENT_SECRET (required unless Vault provides them)
  WIZ_API_URL           (default: https://api.eu26.app.wiz.io/graphql)
  WIZ_AUTH_URL          (default: https://auth.app.wiz.io/oauth/token)
  WIZ_API_TOKEN_CACHE   (default: /tmp/wiz-api-token.json)
  WIZ_API_MAX_PAGES     (default: 10)
  WIZ_API_TIMEOUT       (default: 30)
  WIZ_API_SKIP_VAULT    (default: 0)
EOF
}

main() {
  require_cmd "$WIZ_API_JQ_BIN"
  require_cmd "$WIZ_API_CURL_BIN"

  [[ "$#" -ge 1 ]] || { usage; exit 1; }

  load_credentials

  case "$1" in
    --probe-auth) cmd_probe_auth ;;
    --print-plan) cmd_print_plan ;;
    query)        shift; cmd_query "$@" ;;
    vulns)        shift; cmd_vulns "$@" ;;
    issues)       shift; cmd_issues "$@" ;;
    inventory)    shift; cmd_inventory "$@" ;;
    cloud-config) shift; cmd_cloud_config "$@" ;;
    k8s)          shift; cmd_k8s "$@" ;;
    runtime)      shift; cmd_runtime "$@" ;;
    summary)      shift; cmd_summary "$@" ;;
    -h|--help|help) usage ;;
    *) die "unknown command: $1" ;;
  esac
}

main "$@"
