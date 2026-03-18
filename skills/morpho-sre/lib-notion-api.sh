#!/usr/bin/env bash

NOTION_API_BASE_URL="${NOTION_API_BASE_URL:-https://api.notion.com/v1}"
# Required for /data_sources/* and the data_source search filter.
NOTION_API_VERSION="${NOTION_API_VERSION:-2025-09-03}"
NOTION_API_TIMEOUT="${NOTION_API_TIMEOUT:-30}"
NOTION_VAULT_TIMEOUT="${NOTION_VAULT_TIMEOUT:-15}"
NOTION_CURL_BIN="${NOTION_CURL_BIN:-curl}"
NOTION_JQ_BIN="${NOTION_JQ_BIN:-jq}"
NOTION_SKIP_VAULT="${NOTION_SKIP_VAULT:-0}"
NOTION_VAULT_SECRET_PATH="${NOTION_VAULT_SECRET_PATH:-secret/data/openclaw-sre/all-secrets}"
NOTION_ACTIVE_SECRET="${NOTION_ACTIVE_SECRET:-}"
NOTION_CREDENTIAL_SOURCE="${NOTION_CREDENTIAL_SOURCE:-}"

die() {
  printf 'notion-api:error %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'notion-api:warning %s\n' "$*" >&2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

redact_secret() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    printf '(not set)'
  elif [[ ${#value} -le 12 ]]; then
    printf '***'
  else
    printf '%s...%s' "${value:0:3}" "${value: -3}"
  fi
}

trim() {
  printf '%s' "$1" | awk '{$1=$1; print}'
}

urlencode() {
  printf '%s' "$1" | "$NOTION_JQ_BIN" -sRr @uri
}

urlencode_preserving_pct_encoded() {
  local raw="$1"
  local output="" prefix="" escape=""

  while [[ "$raw" =~ ^([^%]*)%([0-9A-Fa-f]{2})(.*)$ ]]; do
    prefix="${BASH_REMATCH[1]}"
    escape="${BASH_REMATCH[2]}"
    output+="$(urlencode "$prefix")" || return 1
    output+="%${escape}"
    raw="${BASH_REMATCH[3]}"
  done

  output+="$(urlencode "$raw")" || return 1
  printf '%s\n' "$output"
}

normalize_notion_id() {
  local raw
  raw="$(trim "${1:-}")"
  [[ -n "$raw" ]] || die "missing Notion id"
  # Fast fail on obviously invalid inputs while still allowing full Notion URLs.
  [[ ${#raw} -le 2048 ]] || die "invalid Notion id: input too long (${#raw} chars)"

  local extracted=""
  if [[ "$raw" =~ ^https?:// ]]; then
    [[ "$raw" =~ ^https?://[^/]+/.+ ]] || die "invalid Notion URL format: $raw"
    local path_only="$raw"
    path_only="${path_only%%#*}"
    path_only="${path_only%%\?*}"
    extracted="$(printf '%s\n' "$path_only" | grep -Eoi '[0-9a-f]{32}' | tail -n1 || true)"
    [[ -n "$extracted" ]] || die "failed to extract Notion id from URL: $raw"
    raw="$extracted"
  fi

  raw="${raw//-/}"
  [[ "$raw" =~ ^[0-9a-fA-F]{32}$ ]] || die "invalid Notion id: ${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  printf '%s-%s-%s-%s-%s\n' \
    "${raw:0:8}" \
    "${raw:8:4}" \
    "${raw:12:4}" \
    "${raw:16:4}" \
    "${raw:20:12}"
}

validate_page_size() {
  local raw
  raw="$(trim "${1:-}")"
  [[ -n "$raw" ]] || die "invalid --page-size: expected integer 1-100"
  [[ "$raw" =~ ^[0-9]+$ ]] || die "invalid --page-size: expected integer 1-100"
  (( raw >= 1 && raw <= 100 )) || die "invalid --page-size: expected integer 1-100"
  printf '%s\n' "$raw"
}

validate_property_id() {
  local raw
  raw="$(trim "${1:-}")"
  [[ -n "$raw" ]] || die 'missing Notion property id'
  [[ ${#raw} -le 256 ]] || die "invalid Notion property id: input too long (${#raw} chars)"
  [[ "$raw" =~ ^([A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$ ]] || {
    die "invalid Notion property id: ${raw}"
  }
  printf '%s\n' "$raw"
}

extract_notion_secret_from_vault_json() {
  local secret_json="$1"
  local secret_path="$2"

  printf '%s\n' "$secret_json" | "$NOTION_JQ_BIN" -e . >/dev/null 2>&1 || {
    warn "vault returned invalid JSON at ${secret_path}"
    return 1
  }

  local token
  token="$(printf '%s\n' "$secret_json" | "$NOTION_JQ_BIN" -r '.data.data.NOTION_SECRET // empty')" || {
    warn "failed to parse vault secret at ${secret_path}"
    return 1
  }
  [[ -n "$token" ]] || {
    warn "NOTION_SECRET not found in vault path ${secret_path}"
    return 1
  }
  printf '%s\n' "$token"
}

load_secret_from_vault_api() {
  local vault_addr="$1"
  local vault_token="$2"
  local secret_path="$3"
  local source_suffix="$4"

  local secret_json
  secret_json="$(
    "$NOTION_CURL_BIN" -fsS --max-time "$NOTION_VAULT_TIMEOUT" \
      -H "X-Vault-Token: ${vault_token}" \
      "${vault_addr%/}/v1/${secret_path}"
  )" || {
    warn "vault secret fetch failed at ${secret_path}"
    return 1
  }

  local token
  token="$(extract_notion_secret_from_vault_json "$secret_json" "$secret_path")" || return 1
  NOTION_ACTIVE_SECRET="$token"
  NOTION_CREDENTIAL_SOURCE="vault:${secret_path} (${source_suffix})"
  return 0
}

detect_service_account_jwt() {
  local jwt_file="/var/run/secrets/kubernetes.io/serviceaccount/token"
  if [[ -f "$jwt_file" && -s "$jwt_file" ]]; then
    printf '%s\n' "$jwt_file"
    return 0
  fi
  return 1
}

load_secret_from_vault_token() {
  local vault_addr="${VAULT_ADDR:-}"
  local vault_token="${VAULT_TOKEN:-}"
  local secret_path="${NOTION_VAULT_SECRET_PATH:-secret/data/openclaw-sre/all-secrets}"

  [[ -n "$vault_addr" ]] || return 1
  [[ -n "$vault_token" ]] || return 1

  load_secret_from_vault_api "$vault_addr" "$vault_token" "$secret_path" 'cached token'
}

load_secret_from_vault_jwt() {
  local vault_addr="${VAULT_ADDR:-}"
  local auth_path="${VAULT_KUBERNETES_AUTH_PATH:-kubernetes}"
  local role="${VAULT_KUBERNETES_ROLE:-${OPENCLAW_SERVICE_ACCOUNT_NAME:-incident-readonly-agent}}"
  local secret_path="${NOTION_VAULT_SECRET_PATH:-secret/data/openclaw-sre/all-secrets}"

  [[ -n "$vault_addr" ]] || return 1

  local jwt_file
  jwt_file="$(detect_service_account_jwt)" || {
    warn "K8s service account token not available"
    return 1
  }
  local jwt
  jwt="$(tr -d '\r\n' <"$jwt_file")"
  [[ -n "$jwt" ]] || {
    warn "K8s service account token is empty"
    return 1
  }

  local login_payload
  login_payload="$("$NOTION_JQ_BIN" -nc --arg role "$role" --arg jwt "$jwt" '{role:$role,jwt:$jwt}')" || {
    warn "failed to create vault login payload"
    return 1
  }
  local login_json
  login_json="$(
    "$NOTION_CURL_BIN" -fsS --max-time "$NOTION_VAULT_TIMEOUT" \
      -H 'Content-Type: application/json' \
      --data "$login_payload" \
      "${vault_addr%/}/v1/auth/${auth_path}/login"
  )" || {
    warn "vault JWT auth failed (role=${role}, auth_path=${auth_path})"
    return 1
  }

  local vault_token
  vault_token="$(printf '%s\n' "$login_json" | "$NOTION_JQ_BIN" -r '.auth.client_token // empty')"
  [[ -n "$vault_token" ]] || {
    warn "vault returned empty token"
    return 1
  }

  load_secret_from_vault_api "$vault_addr" "$vault_token" "$secret_path" 'jwt auth'
}

load_secret() {
  if [[ -n "${NOTION_SECRET:-}" ]]; then
    NOTION_ACTIVE_SECRET="${NOTION_SECRET}"
    NOTION_CREDENTIAL_SOURCE="env:NOTION_SECRET"
    return 0
  fi
  if [[ -n "${NOTION_TOKEN:-}" ]]; then
    NOTION_ACTIVE_SECRET="${NOTION_TOKEN}"
    NOTION_CREDENTIAL_SOURCE="env:NOTION_TOKEN"
    return 0
  fi
  if [[ "${NOTION_SKIP_VAULT:-0}" == "1" ]]; then
    die "missing NOTION_SECRET/NOTION_TOKEN (Vault lookup skipped via NOTION_SKIP_VAULT=1)"
  fi
  if [[ -n "${VAULT_ADDR:-}" ]]; then
    if load_secret_from_vault_token; then
      return 0
    fi
    if load_secret_from_vault_jwt; then
      return 0
    fi
    die "missing NOTION_SECRET; env unset, Vault lookups failed at ${NOTION_VAULT_SECRET_PATH}"
  fi
  die "missing NOTION_SECRET; env unset and VAULT_ADDR not configured"
}

append_query_param() {
  local url="$1"
  local key="$2"
  local value="$3"
  local sep='?'
  local enc_key enc_value
  [[ "$url" == *\?* ]] && sep='&'
  enc_key="$(urlencode "$key")" || die 'failed to URL-encode query parameter key'
  enc_value="$(urlencode_preserving_pct_encoded "$value")" || die 'failed to URL-encode query parameter value'
  printf '%s%s%s=%s' "$url" "$sep" "$enc_key" "$enc_value"
}

notion_request() {
  [[ $# -ge 3 ]] || die 'notion_request requires at least 3 arguments (method, path, body)'
  local method="$1"
  local path="$2"
  local body="${3:-}"
  shift 3
  local url="${NOTION_API_BASE_URL%/}/${path#/}"
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || die 'notion_request: query parameter key/value args must be in pairs'
    local key="$1"
    local value="$2"
    shift 2
    [[ -n "$value" ]] || continue
    url="$(append_query_param "$url" "$key" "$value")"
  done

  local tmp_body='' tmp_root="${TMPDIR:-/tmp}"
  tmp_body="$(mktemp "${tmp_root%/}/notion-api-body.XXXXXX")" || die 'failed to create temp file'
  trap '[[ -n "${tmp_body:-}" ]] && rm -f "$tmp_body"' RETURN
  local -a curl_args=(
    -sS
    --max-time "$NOTION_API_TIMEOUT"
    -o "$tmp_body"
    -w '%{http_code}'
    -X "$method"
    -H "Authorization: Bearer ${NOTION_ACTIVE_SECRET}"
    -H "Notion-Version: ${NOTION_API_VERSION}"
  )
  if [[ -n "$body" ]]; then
    curl_args+=(
      -H 'Content-Type: application/json'
      --data "$body"
    )
  fi
  local status
  status="$("$NOTION_CURL_BIN" "${curl_args[@]}" "$url")" || {
    local rc=$?
    rm -f "$tmp_body"
    tmp_body=''
    trap - RETURN
    die "request failed (curl exit ${rc}): ${method} ${path}"
  }

  local response
  response="$(cat "$tmp_body")"
  rm -f "$tmp_body"
  tmp_body=''
  trap - RETURN

  if ! printf '%s\n' "$response" | "$NOTION_JQ_BIN" -e . >/dev/null 2>&1; then
    die "invalid JSON response from ${method} ${path}: $(printf '%s' "$response" | head -c 200)"
  fi

  if (( status < 200 || status >= 300 )); then
    local message code
    message="$(printf '%s\n' "$response" | "$NOTION_JQ_BIN" -r '.message // "unknown error"')"
    code="$(printf '%s\n' "$response" | "$NOTION_JQ_BIN" -r '.code // empty')"
    if [[ -n "$code" ]]; then
      die "${method} ${path} failed (${status}, ${code}): ${message}"
    fi
    die "${method} ${path} failed (${status}): ${message}"
  fi

  printf '%s\n' "$response"
}

build_search_body() {
  local query="$1"
  local filter="$2"
  local page_size="$3"
  local start_cursor="$4"

  "$NOTION_JQ_BIN" -nc \
    --arg query "$query" \
    --arg filter "$filter" \
    --arg startCursor "$start_cursor" \
    --argjson pageSize "${page_size:-null}" '
      {}
      | if $query != "" then .query = $query else . end
      | if $filter != "" then .filter = { property: "object", value: $filter } else . end
      | if $startCursor != "" then .start_cursor = $startCursor else . end
      | if $pageSize != null then .page_size = $pageSize else . end
    ' || die 'failed to build search body'
}

build_data_source_query_body() {
  local body_file="$1"
  local page_size="$2"
  local start_cursor="$3"
  local result_type="$4"

  if [[ -n "$body_file" ]]; then
    [[ -f "$body_file" ]] || die "body file not found: $body_file"
    "$NOTION_JQ_BIN" \
      --arg startCursor "$start_cursor" \
      --arg resultType "$result_type" \
      --argjson pageSize "${page_size:-null}" '
        .
        | if $startCursor != "" then .start_cursor = $startCursor else . end
        | if $pageSize != null then .page_size = $pageSize else . end
        | if $resultType != "" then .result_type = $resultType else . end
      ' "$body_file" || die "invalid JSON body file: $body_file"
    return 0
  fi

  "$NOTION_JQ_BIN" -nc \
    --arg startCursor "$start_cursor" \
    --arg resultType "$result_type" \
    --argjson pageSize "${page_size:-null}" '
      {}
      | if $startCursor != "" then .start_cursor = $startCursor else . end
      | if $pageSize != null then .page_size = $pageSize else . end
      | if $resultType != "" then .result_type = $resultType else . end
    ' || die 'failed to build data source query body'
}

print_plan() {
  local resolution='FAILED'
  local source=''
  local redacted='(not set)'
  local preview=''
  if preview="$(
    (
      load_secret
      "$NOTION_JQ_BIN" -nc \
        --arg source "$NOTION_CREDENTIAL_SOURCE" \
        --arg redacted "$(redact_secret "$NOTION_ACTIVE_SECRET")" \
        '{source:$source,redacted:$redacted}'
    )
  )"; then
    resolution='OK'
    source="$(printf '%s\n' "$preview" | "$NOTION_JQ_BIN" -r '.source')"
    redacted="$(printf '%s\n' "$preview" | "$NOTION_JQ_BIN" -r '.redacted')"
  fi

  "$NOTION_JQ_BIN" -nc \
    --arg baseUrl "$NOTION_API_BASE_URL" \
    --arg version "$NOTION_API_VERSION" \
    --arg timeout "$NOTION_API_TIMEOUT" \
    --arg secretPath "$NOTION_VAULT_SECRET_PATH" \
    --arg resolution "$resolution" \
    --arg source "$source" \
    --arg redacted "$redacted" \
    '{
      baseUrl: $baseUrl,
      notionVersion: $version,
      timeoutSeconds: ($timeout | tonumber),
      credentialResolution: $resolution,
      credentialSource: (if $source == "" then null else $source end),
      redactedToken: $redacted,
      envKeys: ["NOTION_SECRET", "NOTION_TOKEN"],
      vaultSecretPath: $secretPath
    }'
}

probe_auth() {
  load_secret
  local response
  response="$(notion_request GET '/users/me' '')"
  printf '%s\n' "$response" | "$NOTION_JQ_BIN" \
    --arg source "$NOTION_CREDENTIAL_SOURCE" \
    --arg version "$NOTION_API_VERSION" \
    '{
      ok: true,
      credentialSource: $source,
      notionVersion: $version,
      userId: .id,
      userType: .type,
      workspaceName: .bot.workspace_name,
      workspaceId: .bot.workspace_id
    }'
}

parse_csv_values() {
  local raw="${1:-}"
  [[ -n "$raw" ]] || return 0
  printf '%s\n' "$raw" \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | awk 'NF > 0 && !seen[$0]++'
}
