#!/usr/bin/env bash
set -euo pipefail

WIZ_MCP_URL="${WIZ_MCP_URL:-https://mcp.app.wiz.io/}"
WIZ_MCP_RESOURCE="${WIZ_MCP_RESOURCE:-https://mcp.app.wiz.io/}"
WIZ_MCP_CURL_BIN="${WIZ_MCP_CURL_BIN:-curl}"
WIZ_MCP_JQ_BIN="${WIZ_MCP_JQ_BIN:-jq}"
WIZ_MCP_NPX_BIN="${WIZ_MCP_NPX_BIN:-npx}"
WIZ_MCP_REMOTE_PACKAGE="${WIZ_MCP_REMOTE_PACKAGE:-mcp-remote@0.1.38}"
WIZ_MCP_ACTIVE_CLIENT_ID=""
WIZ_MCP_ACTIVE_CLIENT_SECRET=""
WIZ_MCP_ACTIVE_DATA_CENTER=""
WIZ_MCP_CREDENTIAL_SOURCE=""
WIZ_MCP_REMOTE_ARGS=()

die() {
  printf 'wiz-mcp: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "missing command: ${cmd}"
}

has_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1
}

trim() {
  printf '%s' "$1" | awk '{$1=$1; print}'
}

looks_like_data_center() {
  local value
  value="$(trim "${1:-}")"
  [[ -n "$value" ]] || return 1
  [[ "$value" =~ ^[a-z]{2}[0-9]+$ ]]
}

resolve_data_center() {
  local explicit="${WIZ_DATA_CENTER:-${WIZ_MCP_DATA_CENTER:-}}"
  if looks_like_data_center "$explicit"; then
    printf '%s\n' "$(trim "$explicit")"
    return 0
  fi

  local endpoint="${WIZ_CLIENT_ENDPOINT:-${WIZ_MCP_CLIENT_ENDPOINT:-}}"
  if looks_like_data_center "$endpoint"; then
    printf '%s\n' "$(trim "$endpoint")"
    return 0
  fi

  return 1
}

load_credentials_from_env() {
  local client_id="${WIZ_CLIENT_ID:-${WIZ_MCP_CLIENT_ID:-}}"
  local client_secret="${WIZ_CLIENT_SECRET:-${WIZ_MCP_CLIENT_SECRET:-}}"
  if [[ -z "$client_id" || -z "$client_secret" ]]; then
    return 1
  fi

  WIZ_MCP_ACTIVE_CLIENT_ID="$client_id"
  WIZ_MCP_ACTIVE_CLIENT_SECRET="$client_secret"
  WIZ_MCP_CREDENTIAL_SOURCE="env"
  local resolved_dc=""
  if resolved_dc="$(resolve_data_center 2>/dev/null)"; then
    WIZ_MCP_ACTIVE_DATA_CENTER="$resolved_dc"
  fi
  return 0
}

detect_service_account_jwt() {
  local jwt_file="${WIZ_MCP_VAULT_JWT_FILE:-/var/run/secrets/kubernetes.io/serviceaccount/token}"
  [[ -f "$jwt_file" ]] || return 1
  [[ -s "$jwt_file" ]] || return 1
  printf '%s\n' "$jwt_file"
}

load_credentials_from_vault() {
  local vault_addr="${VAULT_ADDR:-}"
  local auth_path="${VAULT_KUBERNETES_AUTH_PATH:-kubernetes}"
  local role="${VAULT_KUBERNETES_ROLE:-incident-readonly-agent}"
  local secret_path="${WIZ_MCP_VAULT_SECRET_PATH:-secret/data/wiz/api-token}"
  local jwt_file
  local jwt
  local login_payload
  local login_json
  local vault_token
  local secret_json
  local endpoint

  [[ -n "$vault_addr" ]] || return 1
  jwt_file="$(detect_service_account_jwt)" || return 1
  jwt="$(tr -d '\r\n' <"$jwt_file")"
  [[ -n "$jwt" ]] || return 1

  has_cmd "$WIZ_MCP_CURL_BIN" || return 1
  has_cmd "$WIZ_MCP_JQ_BIN" || return 1

  login_payload="$("$WIZ_MCP_JQ_BIN" -nc --arg role "$role" --arg jwt "$jwt" '{role:$role,jwt:$jwt}')"
  login_json="$(
    "$WIZ_MCP_CURL_BIN" -fsS \
      -H 'Content-Type: application/json' \
      --data "$login_payload" \
      "${vault_addr%/}/v1/auth/${auth_path}/login"
  )" || return 1

  vault_token="$(printf '%s\n' "$login_json" | "$WIZ_MCP_JQ_BIN" -r '.auth.client_token // empty')"
  [[ -n "$vault_token" ]] || return 1

  secret_json="$(
    "$WIZ_MCP_CURL_BIN" -fsS \
      -H "X-Vault-Token: ${vault_token}" \
      "${vault_addr%/}/v1/${secret_path}"
  )" || return 1

  WIZ_MCP_ACTIVE_CLIENT_ID="$(printf '%s\n' "$secret_json" | "$WIZ_MCP_JQ_BIN" -r '.data.data.client_id // empty')"
  WIZ_MCP_ACTIVE_CLIENT_SECRET="$(printf '%s\n' "$secret_json" | "$WIZ_MCP_JQ_BIN" -r '.data.data.client_secret // .data.data.client_token // empty')"
  endpoint="$(printf '%s\n' "$secret_json" | "$WIZ_MCP_JQ_BIN" -r '.data.data.client_endpoint // empty')"
  [[ -n "$WIZ_MCP_ACTIVE_CLIENT_ID" && -n "$WIZ_MCP_ACTIVE_CLIENT_SECRET" ]] || return 1

  WIZ_MCP_CREDENTIAL_SOURCE="vault:${secret_path}"
  local resolved_dc=""
  if looks_like_data_center "$endpoint"; then
    WIZ_MCP_ACTIVE_DATA_CENTER="$endpoint"
  elif resolved_dc="$(resolve_data_center 2>/dev/null)"; then
    WIZ_MCP_ACTIVE_DATA_CENTER="$resolved_dc"
  fi
  return 0
}

load_credentials() {
  if [[ "${WIZ_MCP_SKIP_VAULT:-0}" != "1" ]] && load_credentials_from_vault; then
    return 0
  fi
  if load_credentials_from_env; then
    return 0
  fi
  die "missing Wiz MCP credentials; tried Vault secret ${WIZ_MCP_VAULT_SECRET_PATH:-secret/data/wiz/api-token} and WIZ_CLIENT_ID/WIZ_CLIENT_SECRET"
}

build_remote_args() {
  WIZ_MCP_REMOTE_ARGS=(
    "-y"
    "$WIZ_MCP_REMOTE_PACKAGE"
    "$WIZ_MCP_URL"
    "--resource"
    "$WIZ_MCP_RESOURCE"
    "--header"
    'Wiz-Client-Id: ${WIZ_MCP_ACTIVE_CLIENT_ID}'
    "--header"
    'Wiz-Client-Secret: ${WIZ_MCP_ACTIVE_CLIENT_SECRET}'
  )
  if [[ -n "$WIZ_MCP_ACTIVE_DATA_CENTER" ]]; then
    WIZ_MCP_REMOTE_ARGS+=(
      "--header"
      'Wiz-DataCenter: ${WIZ_MCP_ACTIVE_DATA_CENTER}'
    )
  fi
}

print_plan() {
  build_remote_args
  local args_json
  args_json="$(printf '%s\n' "${WIZ_MCP_REMOTE_ARGS[@]}" | "$WIZ_MCP_JQ_BIN" -Rsc 'split("\n")[:-1]')"
  "$WIZ_MCP_JQ_BIN" -nc \
    --arg command "$WIZ_MCP_NPX_BIN" \
    --arg url "$WIZ_MCP_URL" \
    --arg resource "$WIZ_MCP_RESOURCE" \
    --arg credentialSource "$WIZ_MCP_CREDENTIAL_SOURCE" \
    --arg dataCenter "$WIZ_MCP_ACTIVE_DATA_CENTER" \
    --argjson args "$args_json" \
    '{
      command: $command,
      args: $args,
      url: $url,
      resource: $resource,
      credentialSource: $credentialSource,
      dataCenter: (if $dataCenter == "" then null else $dataCenter end),
      envKeys: (
        [
          "WIZ_MCP_ACTIVE_CLIENT_ID",
          "WIZ_MCP_ACTIVE_CLIENT_SECRET"
        ] + (if $dataCenter == "" then [] else ["WIZ_MCP_ACTIVE_DATA_CENTER"] end)
      )
    }'
}

probe_auth() {
  local probe_headers=()
  local response
  local code
  local body
  local curl_rc=0
  local tmp_body
  probe_headers+=(-H "Wiz-Client-Id: ${WIZ_MCP_ACTIVE_CLIENT_ID}")
  probe_headers+=(-H "Wiz-Client-Secret: ${WIZ_MCP_ACTIVE_CLIENT_SECRET}")
  if [[ -n "$WIZ_MCP_ACTIVE_DATA_CENTER" ]]; then
    probe_headers+=(-H "Wiz-DataCenter: ${WIZ_MCP_ACTIVE_DATA_CENTER}")
  fi
  tmp_body="$(mktemp /tmp/wiz-mcp-probe-body.XXXXXX)"

  response="$(
    "$WIZ_MCP_CURL_BIN" -sS -D - -o "$tmp_body" "${probe_headers[@]}" "$WIZ_MCP_URL"
  )" || curl_rc=$?
  code="$(printf '%s\n' "$response" | sed -n 's/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' | tail -n 1)"
  if [[ -f "$tmp_body" ]]; then
    body="$(tr -d '\r\n' <"$tmp_body" | cut -c1-200)"
  else
    body=""
  fi
  rm -f "$tmp_body"

  "$WIZ_MCP_JQ_BIN" -nc \
    --arg status "${code:-0}" \
    --argjson curlExitCode "$curl_rc" \
    --arg body "$body" \
    --arg credentialSource "$WIZ_MCP_CREDENTIAL_SOURCE" \
    --arg dataCenter "$WIZ_MCP_ACTIVE_DATA_CENTER" \
    '{
      status: ($status | tonumber),
      ok: ((($status | tonumber) >= 200) and (($status | tonumber) < 300)),
      curlExitCode: $curlExitCode,
      bodyPreview: $body,
      credentialSource: $credentialSource,
      dataCenter: (if $dataCenter == "" then null else $dataCenter end)
    }'
}

main() {
  local mode="${1:-run}"

  load_credentials
  build_remote_args

  case "$mode" in
    --print-plan)
      print_plan
      ;;
    --probe-auth)
      probe_auth
      ;;
    run)
      export WIZ_MCP_ACTIVE_CLIENT_ID
      export WIZ_MCP_ACTIVE_CLIENT_SECRET
      if [[ -n "$WIZ_MCP_ACTIVE_DATA_CENTER" ]]; then
        export WIZ_MCP_ACTIVE_DATA_CENTER
      fi
      exec "$WIZ_MCP_NPX_BIN" "${WIZ_MCP_REMOTE_ARGS[@]}"
      ;;
    *)
      die "unsupported mode: ${mode}"
      ;;
  esac
}

main "$@"
