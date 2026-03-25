#!/usr/bin/env bash

INTERCOM_API_REGION="${INTERCOM_API_REGION:-us}"
INTERCOM_API_BASE_URL="${INTERCOM_API_BASE_URL:-}"
INTERCOM_API_VERSION="${INTERCOM_API_VERSION:-2.14}"
INTERCOM_API_TIMEOUT="${INTERCOM_API_TIMEOUT:-30}"
INTERCOM_VAULT_TIMEOUT="${INTERCOM_VAULT_TIMEOUT:-15}"
INTERCOM_CURL_BIN="${INTERCOM_CURL_BIN:-curl}"
INTERCOM_JQ_BIN="${INTERCOM_JQ_BIN:-jq}"
INTERCOM_SKIP_VAULT="${INTERCOM_SKIP_VAULT:-0}"
INTERCOM_VAULT_SECRET_PATH="${INTERCOM_VAULT_SECRET_PATH:-secret/data/openclaw-sre/all-secrets}"
INTERCOM_ALLOWED_HOSTS="${INTERCOM_ALLOWED_HOSTS:-api.intercom.io,api.eu.intercom.io,api.au.intercom.io}"
INTERCOM_ACTIVE_SECRET="${INTERCOM_ACTIVE_SECRET:-}"
INTERCOM_CREDENTIAL_SOURCE="${INTERCOM_CREDENTIAL_SOURCE:-}"

die() {
  printf 'intercom-api:error %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'intercom-api:warning %s\n' "$*" >&2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

trim() {
  printf '%s' "$1" | awk '{$1=$1; print}'
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

urlencode() {
  printf '%s' "$1" | "$INTERCOM_JQ_BIN" -sRr @uri
}

append_query_param() {
  local url="$1"
  local key="$2"
  local value="$3"
  local sep='?'
  [[ "$url" == *\?* ]] && sep='&'
  printf '%s%s%s=%s' \
    "$url" \
    "$sep" \
    "$(urlencode "$key")" \
    "$(urlencode "$value")"
}

default_intercom_base_url() {
  case "$(printf '%s' "${1:-us}" | tr '[:upper:]' '[:lower:]')" in
    us|prod|production|"")
      printf '%s\n' 'https://api.intercom.io'
      ;;
    eu|europe)
      printf '%s\n' 'https://api.eu.intercom.io'
      ;;
    au|australia|apac)
      printf '%s\n' 'https://api.au.intercom.io'
      ;;
    *)
      die "unsupported INTERCOM_API_REGION: ${1:-}"
      ;;
  esac
}

validate_base_url() {
  local raw
  raw="$(trim "${1:-}")"
  [[ -n "$raw" ]] || die 'missing Intercom base URL'
  [[ "$raw" =~ ^https?://[^/?#]+/?$ ]] || die "invalid Intercom base URL: $raw"

  local host allowed matched=0
  host="$(printf '%s\n' "$raw" | sed -E 's#^https?://([^/]+).*$#\1#')"
  host="${host%%:*}"
  while IFS= read -r allowed; do
    [[ -n "$allowed" ]] || continue
    if [[ "$host" == "$allowed" ]]; then
      matched=1
      break
    fi
  done < <(printf '%s\n' "$INTERCOM_ALLOWED_HOSTS" | tr ',' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')

  (( matched == 1 )) || die "blocked Intercom base host: ${host} (allowed: ${INTERCOM_ALLOWED_HOSTS})"
  printf '%s\n' "${raw%/}"
}

resolve_intercom_base_url() {
  local raw="${INTERCOM_API_BASE_URL:-}"
  if [[ -z "$raw" ]]; then
    raw="$(default_intercom_base_url "$INTERCOM_API_REGION")"
  fi
  validate_base_url "$raw"
}

validate_intercom_id() {
  local raw
  raw="$(trim "${1:-}")"
  [[ -n "$raw" ]] || die 'missing Intercom id'
  [[ ${#raw} -le 256 ]] || die "invalid Intercom id: input too long (${#raw} chars)"
  [[ "$raw" =~ ^[A-Za-z0-9._:-]+$ ]] || die "invalid Intercom id: ${1:-}"
  printf '%s\n' "$raw"
}

validate_page_size() {
  local raw
  raw="$(trim "${1:-}")"
  [[ -n "$raw" ]] || die 'invalid --per-page: expected integer 1-150'
  [[ "$raw" =~ ^[0-9]+$ ]] || die 'invalid --per-page: expected integer 1-150'
  (( raw >= 1 && raw <= 150 )) || die 'invalid --per-page: expected integer 1-150'
  printf '%s\n' "$raw"
}

validate_page_number() {
  local raw
  raw="$(trim "${1:-}")"
  [[ -n "$raw" ]] || die 'invalid --page: expected integer >= 1'
  [[ "$raw" =~ ^[0-9]+$ ]] || die 'invalid --page: expected integer >= 1'
  (( raw >= 1 )) || die 'invalid --page: expected integer >= 1'
  printf '%s\n' "$raw"
}

validate_starting_after() {
  local raw
  raw="$(trim "${1:-}")"
  [[ -n "$raw" ]] || die 'invalid --starting-after: value is empty'
  [[ ${#raw} -le 1024 ]] || die "invalid --starting-after: input too long (${#raw} chars)"
  [[ "$raw" != *$'\n'* ]] || die 'invalid --starting-after: newlines are not allowed'
  printf '%s\n' "$raw"
}

read_json_object() {
  local source="$1"
  printf '%s\n' "$source" | "$INTERCOM_JQ_BIN" -ce '
    if type == "object" then
      .
    else
      error("body must be a JSON object")
    end
  ' || die 'invalid JSON body: expected object'
}

load_json_body_source() {
  local body_file="$1"
  local body_inline="$2"
  local use_stdin="$3"
  local source_count=0
  local raw=''

  if [[ -n "$body_file" ]]; then
    ((source_count += 1))
    [[ -f "$body_file" ]] || die "body file not found: $body_file"
    raw="$(cat "$body_file")"
  fi
  if [[ -n "$body_inline" ]]; then
    ((source_count += 1))
    raw="$body_inline"
  fi
  if [[ "$use_stdin" == "1" ]]; then
    ((source_count += 1))
    raw="$(cat)"
  fi

  (( source_count == 1 )) || die 'exactly one of --body-file, --body, or --stdin is required'
  read_json_object "$raw"
}

merge_search_pagination() {
  local body_json="$1"
  local per_page="${2:-}"
  local starting_after="${3:-}"

  "$INTERCOM_JQ_BIN" -nce \
    --argjson body "$body_json" \
    --argjson perPage "${per_page:-null}" \
    --arg startingAfter "$starting_after" '
      $body
      | if $perPage != null or $startingAfter != "" then
          .pagination = (.pagination // {})
          | if $perPage != null then .pagination.per_page = $perPage else . end
          | if $startingAfter != "" then .pagination.starting_after = $startingAfter else . end
        else
          .
        end
    ' || die 'failed to merge Intercom search pagination'
}

extract_intercom_secret_from_vault_json() {
  local secret_json="$1"
  local secret_path="$2"

  printf '%s\n' "$secret_json" | "$INTERCOM_JQ_BIN" -e . >/dev/null 2>&1 || {
    warn "vault returned invalid JSON at ${secret_path}"
    return 1
  }

  local token
  token="$(printf '%s\n' "$secret_json" | "$INTERCOM_JQ_BIN" -r '.data.data.INTERCOM_SECRET // empty')" || {
    warn "failed to parse vault secret at ${secret_path}"
    return 1
  }
  [[ -n "$token" ]] || {
    warn "INTERCOM_SECRET not found in vault path ${secret_path}"
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
    "$INTERCOM_CURL_BIN" -fsS --max-time "$INTERCOM_VAULT_TIMEOUT" \
      -H "X-Vault-Token: ${vault_token}" \
      "${vault_addr%/}/v1/${secret_path}"
  )" || {
    warn "vault secret fetch failed at ${secret_path}"
    return 1
  }

  local token
  token="$(extract_intercom_secret_from_vault_json "$secret_json" "$secret_path")" || return 1
  INTERCOM_ACTIVE_SECRET="$token"
  INTERCOM_CREDENTIAL_SOURCE="vault:${secret_path} (${source_suffix})"
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
  local secret_path="${INTERCOM_VAULT_SECRET_PATH:-secret/data/openclaw-sre/all-secrets}"

  [[ -n "$vault_addr" ]] || return 1
  [[ -n "$vault_token" ]] || return 1

  load_secret_from_vault_api "$vault_addr" "$vault_token" "$secret_path" 'cached token'
}

load_secret_from_vault_jwt() {
  local vault_addr="${VAULT_ADDR:-}"
  local auth_path="${VAULT_KUBERNETES_AUTH_PATH:-kubernetes}"
  local role="${VAULT_KUBERNETES_ROLE:-${OPENCLAW_SERVICE_ACCOUNT_NAME:-incident-readonly-agent}}"
  local secret_path="${INTERCOM_VAULT_SECRET_PATH:-secret/data/openclaw-sre/all-secrets}"

  [[ -n "$vault_addr" ]] || return 1

  local jwt_file
  jwt_file="$(detect_service_account_jwt)" || {
    warn 'K8s service account token not available'
    return 1
  }
  local jwt
  jwt="$(tr -d '\r\n' <"$jwt_file")"
  [[ -n "$jwt" ]] || {
    warn 'K8s service account token is empty'
    return 1
  }

  local login_payload
  login_payload="$("$INTERCOM_JQ_BIN" -nc --arg role "$role" --arg jwt "$jwt" '{role:$role,jwt:$jwt}')" || {
    warn 'failed to create vault login payload'
    return 1
  }
  local login_json
  login_json="$(
    "$INTERCOM_CURL_BIN" -fsS --max-time "$INTERCOM_VAULT_TIMEOUT" \
      -H 'Content-Type: application/json' \
      --data "$login_payload" \
      "${vault_addr%/}/v1/auth/${auth_path}/login"
  )" || {
    warn "vault JWT auth failed (role=${role}, auth_path=${auth_path})"
    return 1
  }

  local vault_token
  vault_token="$(printf '%s\n' "$login_json" | "$INTERCOM_JQ_BIN" -r '.auth.client_token // empty')"
  [[ -n "$vault_token" ]] || {
    warn 'vault returned empty token'
    return 1
  }

  load_secret_from_vault_api "$vault_addr" "$vault_token" "$secret_path" 'jwt auth'
}

load_secret() {
  if [[ -n "${INTERCOM_SECRET:-}" ]]; then
    INTERCOM_ACTIVE_SECRET="${INTERCOM_SECRET}"
    INTERCOM_CREDENTIAL_SOURCE='env:INTERCOM_SECRET'
    return 0
  fi
  if [[ -n "${INTERCOM_TOKEN:-}" ]]; then
    INTERCOM_ACTIVE_SECRET="${INTERCOM_TOKEN}"
    INTERCOM_CREDENTIAL_SOURCE='env:INTERCOM_TOKEN'
    return 0
  fi
  if [[ "${INTERCOM_SKIP_VAULT:-0}" == "1" ]]; then
    die 'missing INTERCOM_SECRET/INTERCOM_TOKEN (Vault lookup skipped via INTERCOM_SKIP_VAULT=1)'
  fi
  if [[ -n "${VAULT_ADDR:-}" ]]; then
    if load_secret_from_vault_token; then
      return 0
    fi
    if load_secret_from_vault_jwt; then
      return 0
    fi
    die "missing INTERCOM_SECRET; env unset, Vault lookups failed at ${INTERCOM_VAULT_SECRET_PATH}"
  fi
  die 'missing INTERCOM_SECRET; env unset and VAULT_ADDR not configured'
}

validate_readonly_raw_path() {
  local method="$1"
  local raw_path="$2"
  local path_without_query="${raw_path%%\?*}"
  local segment='[A-Za-z0-9._:-]+'

  [[ -n "$raw_path" ]] || die 'missing Intercom path'
  [[ "$raw_path" == /* ]] || die "Intercom path must start with / (got: ${raw_path})"
  [[ "$raw_path" != *'#'* ]] || die "Intercom path must not contain fragments: ${raw_path}"
  [[ "$path_without_query" != *'..'* ]] || die "Intercom path must not contain '..': ${raw_path}"
  [[ "$path_without_query" != *'//' ]] || die "Intercom path must not contain '//': ${raw_path}"

  case "$method" in
    GET)
      [[ "$path_without_query" =~ ^/me$|^/admins$|^/admins/activity_logs$|^/admins/${segment}$|^/contacts$|^/contacts/${segment}$|^/contacts/${segment}/companies$|^/companies$|^/companies/${segment}$|^/companies/${segment}/contacts$|^/conversations$|^/conversations/${segment}$|^/ticket_types$|^/ticket_types/${segment}$|^/tickets/${segment}$ ]] \
        || die "blocked unsupported Intercom GET path: ${path_without_query}"
      ;;
    POST)
      [[ "$path_without_query" =~ ^/contacts/search$|^/conversations/search$|^/tickets/search$|^/companies/list$ ]] \
        || die "blocked unsupported Intercom POST path: ${path_without_query}"
      ;;
    *)
      die "unsupported Intercom method: ${method}"
      ;;
  esac
}

intercom_request() {
  [[ $# -ge 3 ]] || die 'intercom_request requires at least 3 arguments (method, path, body)'
  local method="$1"
  local path="$2"
  local body="${3:-}"
  shift 3

  local url
  url="$(resolve_intercom_base_url)"
  [[ "$path" == /* ]] || die "Intercom path must start with / (got: ${path})"
  url="${url}${path}"
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || die 'intercom_request: query parameter key/value args must be in pairs'
    local key="$1"
    local value="$2"
    shift 2
    [[ -n "$value" ]] || continue
    url="$(append_query_param "$url" "$key" "$value")"
  done

  local tmp_body='' tmp_root="${TMPDIR:-/tmp}"
  tmp_body="$(mktemp "${tmp_root%/}/intercom-api-body.XXXXXX")" || die 'failed to create temp file'
  trap '[[ -n "${tmp_body:-}" ]] && rm -f "$tmp_body"' RETURN
  local -a curl_args=(
    -sS
    --max-time "$INTERCOM_API_TIMEOUT"
    -o "$tmp_body"
    -w '%{http_code}'
    -X "$method"
    -H "Authorization: Bearer ${INTERCOM_ACTIVE_SECRET}"
    -H "Intercom-Version: ${INTERCOM_API_VERSION}"
    -H 'Accept: application/json'
  )
  if [[ -n "$body" ]]; then
    curl_args+=(
      -H 'Content-Type: application/json'
      --data "$body"
    )
  fi

  local status
  status="$("$INTERCOM_CURL_BIN" "${curl_args[@]}" "$url")" || {
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

  [[ "$status" =~ ^[0-9]{3}$ ]] || die "invalid HTTP status from ${method} ${path}: ${status}"

  if ! printf '%s\n' "$response" | "$INTERCOM_JQ_BIN" -e . >/dev/null 2>&1; then
    die "invalid JSON response from ${method} ${path}: $(printf '%s' "$response" | head -c 200)"
  fi

  if (( status < 200 || status >= 300 )); then
    local message code request_id
    message="$(printf '%s\n' "$response" | "$INTERCOM_JQ_BIN" -r '.errors[0].message // .message // "unknown error"')"
    code="$(printf '%s\n' "$response" | "$INTERCOM_JQ_BIN" -r '.errors[0].code // .type // empty')"
    request_id="$(printf '%s\n' "$response" | "$INTERCOM_JQ_BIN" -r '.request_id // empty')"
    if [[ -n "$code" && -n "$request_id" ]]; then
      die "${method} ${path} failed (${status}, ${code}, request_id=${request_id}): ${message}"
    elif [[ -n "$code" ]]; then
      die "${method} ${path} failed (${status}, ${code}): ${message}"
    fi
    die "${method} ${path} failed (${status}): ${message}"
  fi

  printf '%s\n' "$response"
}

print_plan() {
  local base_url
  base_url="$(resolve_intercom_base_url)"
  local resolution='FAILED'
  local source=''
  local redacted='(not set)'
  local preview=''
  if preview="$(
    (
      load_secret
      "$INTERCOM_JQ_BIN" -nc \
        --arg source "$INTERCOM_CREDENTIAL_SOURCE" \
        --arg redacted "$(redact_secret "$INTERCOM_ACTIVE_SECRET")" \
        '{source:$source,redacted:$redacted}'
    )
  )"; then
    resolution='OK'
    source="$(printf '%s\n' "$preview" | "$INTERCOM_JQ_BIN" -r '.source')"
    redacted="$(printf '%s\n' "$preview" | "$INTERCOM_JQ_BIN" -r '.redacted')"
  fi

  "$INTERCOM_JQ_BIN" -nc \
    --arg baseUrl "$base_url" \
    --arg region "$INTERCOM_API_REGION" \
    --arg version "$INTERCOM_API_VERSION" \
    --arg timeout "$INTERCOM_API_TIMEOUT" \
    --arg secretPath "$INTERCOM_VAULT_SECRET_PATH" \
    --arg resolution "$resolution" \
    --arg source "$source" \
    --arg redacted "$redacted" \
    '{
      baseUrl: $baseUrl,
      region: $region,
      intercomVersion: $version,
      timeoutSeconds: ($timeout | tonumber),
      credentialResolution: $resolution,
      credentialSource: (if $source == "" then null else $source end),
      redactedToken: $redacted,
      envKeys: ["INTERCOM_SECRET", "INTERCOM_TOKEN"],
      vaultSecretPath: $secretPath
    }'
}

probe_auth() {
  load_secret
  local base_url
  base_url="$(resolve_intercom_base_url)"
  local response
  response="$(intercom_request GET '/me' '')"
  printf '%s\n' "$response" | "$INTERCOM_JQ_BIN" \
    --arg source "$INTERCOM_CREDENTIAL_SOURCE" \
    --arg version "$INTERCOM_API_VERSION" \
    --arg baseUrl "$base_url" '
      {
        ok: true,
        credentialSource: $source,
        intercomVersion: $version,
        baseUrl: $baseUrl,
        adminId: (.id // null),
        adminName: (.name // null),
        adminEmail: (.email // null),
        adminType: (.type // null)
      }
    '
}
