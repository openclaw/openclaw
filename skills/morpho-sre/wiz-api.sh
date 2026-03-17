#!/usr/bin/env bash
set -euo pipefail

WIZ_API_URL="${WIZ_API_URL:-https://api.eu26.app.wiz.io/graphql}"
WIZ_AUTH_URL="${WIZ_AUTH_URL:-https://auth.app.wiz.io/oauth/token}"
WIZ_AUTH_AUDIENCE="${WIZ_AUTH_AUDIENCE:-wiz-api}"
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
WIZ_API_TMP_DIR=""

cleanup_tmp() {
  if [[ -n "$WIZ_API_TMP_DIR" && -d "$WIZ_API_TMP_DIR" ]]; then
    rm -rf "$WIZ_API_TMP_DIR"
  fi
}
ensure_tmp_dir() {
  if [[ -z "$WIZ_API_TMP_DIR" ]]; then
    WIZ_API_TMP_DIR="$(mktemp -d /tmp/wiz-api.XXXXXX)"
    trap cleanup_tmp EXIT
  fi
}

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

# Normalize comma-separated enum values: uppercase + trim whitespace
normalize_csv_upper() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '\n' ',' | sed 's/,$//'
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

load_cached_token() {
  local cache="$WIZ_API_TOKEN_CACHE"
  [[ -f "$cache" ]] || return 1
  local expires_at
  expires_at="$("$WIZ_API_JQ_BIN" -r '.expires_at // 0' "$cache" 2>/dev/null)" || return 1
  local now
  now="$(date +%s)"
  if [[ "$expires_at" -gt $((now + 60)) ]]; then
    WIZ_API_BEARER_TOKEN="$("$WIZ_API_JQ_BIN" -r '.access_token // empty' "$cache")"
    [[ -n "$WIZ_API_BEARER_TOKEN" ]] || return 1
    return 0
  fi
  return 1
}

save_cached_token() {
  local token="$1"
  local expires_in="$2"
  local now expires_at tmp_file
  now="$(date +%s)"
  expires_at=$((now + expires_in))
  tmp_file="$(mktemp "${WIZ_API_TOKEN_CACHE}.XXXXXX")"
  "$WIZ_API_JQ_BIN" -nc \
    --arg access_token "$token" \
    --argjson expires_at "$expires_at" \
    '{ access_token: $access_token, expires_at: $expires_at }' >"$tmp_file"
  chmod 600 "$tmp_file"
  mv -f "$tmp_file" "$WIZ_API_TOKEN_CACHE"
}

authenticate() {
  local response access_token expires_in
  response="$(
    "$WIZ_API_CURL_BIN" -sS --max-time "$WIZ_API_TIMEOUT" \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-urlencode "grant_type=client_credentials" \
      --data-urlencode "client_id=${WIZ_API_ACTIVE_CLIENT_ID}" \
      --data-urlencode "client_secret=${WIZ_API_ACTIVE_CLIENT_SECRET}" \
      --data-urlencode "audience=${WIZ_AUTH_AUDIENCE}" \
      "$WIZ_AUTH_URL"
  )" || die "auth request failed"

  printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -e . >/dev/null 2>&1 || die "auth response is not valid JSON: $(printf '%s' "$response" | head -c 200)"
  access_token="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r '.access_token // empty')"
  [[ -n "$access_token" ]] || die "auth failed: $(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r '.error_description // .error // "missing access_token"')"
  expires_in="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r '.expires_in // 3600 | floor')"

  save_cached_token "$access_token" "$expires_in"
  WIZ_API_BEARER_TOKEN="$access_token"
}

ensure_token() {
  if load_cached_token; then
    return 0
  fi
  authenticate
}

wiz_graphql_with_retry() {
  local query="$1"
  local vars_json="${2:-"{}"}"
  local response error_msg tmp_body http_code payload

  ensure_token

  payload="$("$WIZ_API_JQ_BIN" -nc \
    --arg query "$query" \
    --argjson variables "$vars_json" \
    '{ query: $query, variables: $variables }'
  )" || die "failed to build GraphQL payload"

  ensure_tmp_dir
  tmp_body="$(mktemp "${WIZ_API_TMP_DIR}/body.XXXXXX")"

  http_code="$(
    "$WIZ_API_CURL_BIN" -sS --max-time "$WIZ_API_TIMEOUT" \
      -o "$tmp_body" -w '%{http_code}' \
      -H "Authorization: Bearer ${WIZ_API_BEARER_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data "$payload" \
      "$WIZ_API_URL"
  )" || {
    rm -f "$tmp_body"
    die "GraphQL request failed (curl error)"
  }

  response="$(cat "$tmp_body")"
  rm -f "$tmp_body"

  # 401 → invalidate cache, re-auth, retry once
  if [[ "$http_code" == "401" ]]; then
    rm -f "$WIZ_API_TOKEN_CACHE"
    WIZ_API_BEARER_TOKEN=""
    authenticate

    tmp_body="$(mktemp "${WIZ_API_TMP_DIR}/body.XXXXXX")"
    http_code="$(
      "$WIZ_API_CURL_BIN" -sS --max-time "$WIZ_API_TIMEOUT" \
        -o "$tmp_body" -w '%{http_code}' \
        -H "Authorization: Bearer ${WIZ_API_BEARER_TOKEN}" \
        -H 'Content-Type: application/json' \
        --data "$payload" \
        "$WIZ_API_URL"
    )" || {
      rm -f "$tmp_body"
      die "GraphQL retry failed (curl error)"
    }
    response="$(cat "$tmp_body")"
    rm -f "$tmp_body"
  fi

  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    die "GraphQL request returned HTTP ${http_code}: $(printf '%s' "$response" | head -c 200)"
  fi

  printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -e . >/dev/null 2>&1 || die "invalid JSON response"

  if printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -e '.errors and (.errors | length > 0)' >/dev/null 2>&1; then
    error_msg="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r '.errors[0].message // "unknown GraphQL error"')"
    die "GraphQL error: ${error_msg}"
  fi

  printf '%s\n' "$response"
}

paginated_query() {
  local query="$1"
  local vars_json="$2"
  local data_path="$3"
  local max_pages="${4:-$WIZ_API_MAX_PAGES}"
  local page=0
  local all_nodes="[]"
  local cursor="null"
  local response page_nodes has_next end_cursor

  while [[ "$page" -lt "$max_pages" ]]; do
    local page_vars
    if [[ "$cursor" == "null" ]]; then
      page_vars="$vars_json"
    else
      page_vars="$(printf '%s\n' "$vars_json" | "$WIZ_API_JQ_BIN" -c --arg after "$cursor" '. + {after: $after}')" || die "failed to build pagination variables"
    fi

    response="$(wiz_graphql_with_retry "$query" "$page_vars")"
    page_nodes="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -c "${data_path}.nodes // []")"
    all_nodes="$(printf '%s\n%s\n' "$all_nodes" "$page_nodes" | "$WIZ_API_JQ_BIN" -sc '.[0] + .[1]')"

    has_next="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r "${data_path}.pageInfo.hasNextPage // false")"
    if [[ "$has_next" != "true" ]]; then
      break
    fi

    end_cursor="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r "${data_path}.pageInfo.endCursor // empty")"
    if [[ -z "$end_cursor" ]]; then
      break
    fi

    cursor="$end_cursor"
    page=$((page + 1))
  done

  printf '%s\n' "$all_nodes" | "$WIZ_API_JQ_BIN" -c '.'
}

cmd_query() {
  local query_input="${1:-}"
  local vars_json="${2:-"{}"}"
  [[ -n "$query_input" ]] || die "usage: query <graphql_string_or_@file> [variables_json]"

  local query
  if [[ "$query_input" == @* ]]; then
    local file_path="${query_input#@}"
    [[ -f "$file_path" ]] || die "query file not found: ${file_path}"
    query="$(cat "$file_path")"
  else
    query="$query_input"
  fi

  wiz_graphql_with_retry "$query" "$vars_json" | "$WIZ_API_JQ_BIN" -c '.'
}

cmd_probe_auth() {
  ensure_token
  local now expires_at
  now="$(date +%s)"
  expires_at="$("$WIZ_API_JQ_BIN" -r '.expires_at // 0' "$WIZ_API_TOKEN_CACHE" 2>/dev/null || printf '0')"
  "$WIZ_API_JQ_BIN" -nc \
    --arg credentialSource "$WIZ_API_CREDENTIAL_SOURCE" \
    --argjson tokenExpiry "$expires_at" \
    --argjson now "$now" \
    '{
      ok: true,
      credentialSource: $credentialSource,
      tokenExpiry: $tokenExpiry,
      tokenTTL: ($tokenExpiry - $now)
    }'
}

cmd_print_plan() {
  "$WIZ_API_JQ_BIN" -nc \
    --arg apiUrl "$WIZ_API_URL" \
    --arg authUrl "$WIZ_AUTH_URL" \
    --arg authAudience "$WIZ_AUTH_AUDIENCE" \
    --arg tokenCache "$WIZ_API_TOKEN_CACHE" \
    --arg credentialSource "$WIZ_API_CREDENTIAL_SOURCE" \
    --argjson maxPages "$WIZ_API_MAX_PAGES" \
    --argjson timeout "$WIZ_API_TIMEOUT" \
    '{
      apiUrl: $apiUrl,
      authUrl: $authUrl,
      authAudience: $authAudience,
      tokenCache: $tokenCache,
      credentialSource: $credentialSource,
      maxPages: $maxPages,
      timeout: $timeout
    }'
}

cmd_issues() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local severity="" status="" issue_type="" entity_type=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --severity)    severity="$2"; shift 2 ;;
      --status)      status="$2"; shift 2 ;;
      --type)        issue_type="$2"; shift 2 ;;
      --entity-type) entity_type="$2"; shift 2 ;;
      --first)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --first: must be a non-negative integer"
        first="$2"; shift 2 ;;
      --max-pages)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --max-pages: must be a non-negative integer"
        max_pages="$2"; shift 2 ;;
      *) die "unknown issues flag: $1" ;;
    esac
  done

  # Build filter JSON via jq — enum values normalized to uppercase
  local filter_json="{}"
  if [[ -n "$severity" ]]; then
    severity="$(normalize_csv_upper "$severity")"
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg s "$severity" '. + {severity: ($s | split(","))}')"
  fi
  if [[ -n "$status" ]]; then
    status="$(normalize_csv_upper "$status")"
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg s "$status" '. + {status: ($s | split(","))}')"
  fi
  if [[ -n "$issue_type" ]]; then
    issue_type="$(normalize_csv_upper "$issue_type")"
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg s "$issue_type" '. + {type: ($s | split(","))}')"
  fi
  if [[ -n "$entity_type" ]]; then
    entity_type="$(normalize_csv_upper "$entity_type")"
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg s "$entity_type" '. + {entityType: ($s | split(","))}')"
  fi

  local query
  query='query($first: Int, $after: String, $filterBy: IssueFilters) {
    issuesV2(first: $first, after: $after, filterBy: $filterBy, orderBy: { field: SEVERITY, direction: DESC }) {
      nodes {
        id
        sourceRule { name }
        severity
        status
        type
        entitySnapshot { name type }
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }'

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" --argjson filterBy "$filter_json" '{ first: $first, filterBy: $filterBy }')"
  paginated_query "$query" "$vars_json" '.data.issuesV2' "$max_pages"
}

cmd_vulns() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local severity="" image="" cve="" has_fix=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --severity)  severity="$2"; shift 2 ;;
      --image)     image="$2"; shift 2 ;;
      --cve)       cve="$2"; shift 2 ;;
      --has-fix)   has_fix="true"; shift ;;
      --first)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --first: must be a non-negative integer"
        first="$2"; shift 2 ;;
      --max-pages)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --max-pages: must be a non-negative integer"
        max_pages="$2"; shift 2 ;;
      *) die "unknown vulns flag: $1" ;;
    esac
  done

  # Build filter JSON via jq — enum values normalized to uppercase
  local filter_json="{}"
  if [[ -n "$severity" ]]; then
    severity="$(normalize_csv_upper "$severity")"
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg s "$severity" '. + {severity: ($s | split(","))}')"
  fi
  if [[ -n "$image" ]]; then
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg v "$image" '. + {imageName: $v}')"
  fi
  if [[ -n "$cve" ]]; then
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg v "$cve" '. + {name: $v}')"
  fi
  if [[ "$has_fix" == "true" ]]; then
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c '. + {hasFix: true}')"
  fi

  local query
  query='query($first: Int, $after: String, $filterBy: VulnerabilityFindingFilters) {
    vulnerabilityFindings(first: $first, after: $after, filterBy: $filterBy) {
      nodes {
        id
        name
        severity
        score
        hasFix
        fixedVersion
        detailedName
        version
        firstDetectedAt
        lastDetectedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }'

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" --argjson filterBy "$filter_json" '{ first: $first, filterBy: $filterBy }')"
  paginated_query "$query" "$vars_json" '.data.vulnerabilityFindings' "$max_pages"
}

cmd_inventory() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local res_type="" subscription="" search=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --type)         res_type="$2"; shift 2 ;;
      --subscription) subscription="$2"; shift 2 ;;
      --search)       search="$2"; shift 2 ;;
      --first)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --first: must be a non-negative integer"
        first="$2"; shift 2 ;;
      --max-pages)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --max-pages: must be a non-negative integer"
        max_pages="$2"; shift 2 ;;
      *) die "unknown inventory flag: $1" ;;
    esac
  done

  local where_clause="[]"
  if [[ -n "$res_type" ]]; then
    where_clause="$(printf '%s' "$where_clause" | "$WIZ_API_JQ_BIN" -c --arg v "$res_type" '. + [{type: {equals: [$v]}}]')"
  fi
  if [[ -n "$subscription" ]]; then
    where_clause="$(printf '%s' "$where_clause" | "$WIZ_API_JQ_BIN" -c --arg v "$subscription" '. + [{subscription: {equals: [$v]}}]')"
  fi
  if [[ -n "$search" ]]; then
    where_clause="$(printf '%s' "$where_clause" | "$WIZ_API_JQ_BIN" -c --arg v "$search" '. + [{name: {contains: $v}}]')"
  fi

  local query
  query="query(\$first: Int, \$after: String, \$where: [GraphEntityQueryInput!]) {
    graphSearch(first: \$first, after: \$after, query: { type: [\"CLOUD_RESOURCE\"], where: { AND: \$where } }) {
      nodes {
        entities {
          id
          name
          type
          properties
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }"

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" --argjson where "$where_clause" '{ first: $first, where: $where }')"
  paginated_query "$query" "$vars_json" '.data.graphSearch' "$max_pages"
}

cmd_cloud_config() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local severity="" rule="" status=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --severity)  severity="$2"; shift 2 ;;
      --rule)      rule="$2"; shift 2 ;;
      --status)    status="$2"; shift 2 ;;
      --first)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --first: must be a non-negative integer"
        first="$2"; shift 2 ;;
      --max-pages)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --max-pages: must be a non-negative integer"
        max_pages="$2"; shift 2 ;;
      *) die "unknown cloud-config flag: $1" ;;
    esac
  done

  # Build filter JSON via jq — enum values normalized to uppercase
  local filter_json="{}"
  if [[ -n "$severity" ]]; then
    severity="$(normalize_csv_upper "$severity")"
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg s "$severity" '. + {severity: ($s | split(","))}')"
  fi
  if [[ -n "$rule" ]]; then
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg v "$rule" '. + {rule: $v}')"
  fi
  if [[ -n "$status" ]]; then
    status="$(normalize_csv_upper "$status")"
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg s "$status" '. + {status: ($s | split(","))}')"
  fi

  local query
  query='query($first: Int, $after: String, $filterBy: ConfigurationFindingFilters) {
    configurationFindings(first: $first, after: $after, filterBy: $filterBy) {
      nodes {
        id
        severity
        status
        result
        rule { name description severity }
        resource { id name type }
        analyzedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }'

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" --argjson filterBy "$filter_json" '{ first: $first, filterBy: $filterBy }')"
  paginated_query "$query" "$vars_json" '.data.configurationFindings' "$max_pages"
}

cmd_k8s() {
  local first=20 max_pages="$WIZ_API_MAX_PAGES"
  local cluster=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --cluster)   cluster="$2"; shift 2 ;;
      --first)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --first: must be a non-negative integer"
        first="$2"; shift 2 ;;
      --max-pages)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --max-pages: must be a non-negative integer"
        max_pages="$2"; shift 2 ;;
      *) die "unknown k8s flag: $1" ;;
    esac
  done

  # Build filter JSON via jq — search is a string, passed as a variable for safety
  local filter_json="{}"
  if [[ -n "$cluster" ]]; then
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg v "$cluster" '. + {search: $v}')"
  fi

  local query
  query='query($first: Int, $after: String, $filterBy: KubernetesClusterFilters) {
    kubernetesClusters(first: $first, after: $after, filterBy: $filterBy) {
      nodes {
        id
        name
        cloudAccount { name }
        status
        kind
      }
      pageInfo { hasNextPage endCursor }
    }
  }'

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" --argjson filterBy "$filter_json" '{ first: $first, filterBy: $filterBy }')"
  paginated_query "$query" "$vars_json" '.data.kubernetesClusters' "$max_pages"
}

cmd_runtime() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local severity=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --severity)  severity="$2"; shift 2 ;;
      --first)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --first: must be a non-negative integer"
        first="$2"; shift 2 ;;
      --max-pages)
        [[ "$2" =~ ^[0-9]+$ ]] || die "invalid --max-pages: must be a non-negative integer"
        max_pages="$2"; shift 2 ;;
      *) die "unknown runtime flag: $1" ;;
    esac
  done

  # Build filter JSON via jq — enum values normalized to uppercase
  local filter_json="{}"
  if [[ -n "$severity" ]]; then
    severity="$(normalize_csv_upper "$severity")"
    filter_json="$(printf '%s' "$filter_json" | "$WIZ_API_JQ_BIN" -c --arg s "$severity" '. + {severity: ($s | split(","))}')"
  fi

  local query
  query='query($first: Int, $after: String, $filterBy: CloudEventFilters) {
    cloudEvents(first: $first, after: $after, filterBy: $filterBy) {
      edges {
        node {
          ... on CloudEvent {
            id
            name
            severity
            category
            cloudPlatform
            kind
            status
            timestamp
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }'

  # cloudEvents uses edges/node pattern — fetch pages manually and flatten
  local page=0 all_nodes="[]" cursor="null"
  while [[ "$page" -lt "$max_pages" ]]; do
    local page_vars
    if [[ "$cursor" == "null" ]]; then
      page_vars="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" --argjson filterBy "$filter_json" '{ first: $first, filterBy: $filterBy }')"
    else
      page_vars="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" --argjson filterBy "$filter_json" --arg after "$cursor" '{ first: $first, filterBy: $filterBy, after: $after }')"
    fi
    local response
    response="$(wiz_graphql_with_retry "$query" "$page_vars")"
    local page_nodes
    page_nodes="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -c '[.data.cloudEvents.edges[].node]')"
    all_nodes="$(printf '%s\n%s\n' "$all_nodes" "$page_nodes" | "$WIZ_API_JQ_BIN" -sc '.[0] + .[1]')"
    local has_next
    has_next="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r '.data.cloudEvents.pageInfo.hasNextPage')"
    if [[ "$has_next" != "true" ]]; then break; fi
    local end_cursor
    end_cursor="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r '.data.cloudEvents.pageInfo.endCursor')"
    if [[ -z "$end_cursor" || "$end_cursor" == "null" ]]; then break; fi
    cursor="$end_cursor"
    page=$((page + 1))
  done
  printf '%s\n' "$all_nodes" | "$WIZ_API_JQ_BIN" -c '.'
}

cmd_summary() {
  local summary_query='query {
    ic: issuesV2(first: 0, filterBy: {severity: [CRITICAL]}) { totalCount }
    ih: issuesV2(first: 0, filterBy: {severity: [HIGH]}) { totalCount }
    im: issuesV2(first: 0, filterBy: {severity: [MEDIUM]}) { totalCount }
    il: issuesV2(first: 0, filterBy: {severity: [LOW]}) { totalCount }
    ii: issuesV2(first: 0, filterBy: {severity: [INFORMATIONAL]}) { totalCount }
    vc: vulnerabilityFindings(first: 0, filterBy: {severity: [CRITICAL]}) { totalCount }
    vh: vulnerabilityFindings(first: 0, filterBy: {severity: [HIGH]}) { totalCount }
    vm: vulnerabilityFindings(first: 0, filterBy: {severity: [MEDIUM]}) { totalCount }
    vl: vulnerabilityFindings(first: 0, filterBy: {severity: [LOW]}) { totalCount }
    cc: configurationFindings(first: 0, filterBy: {severity: [CRITICAL]}) { totalCount }
    ch: configurationFindings(first: 0, filterBy: {severity: [HIGH]}) { totalCount }
    cm: configurationFindings(first: 0, filterBy: {severity: [MEDIUM]}) { totalCount }
    cl: configurationFindings(first: 0, filterBy: {severity: [LOW]}) { totalCount }
  }'

  local timestamp resp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  resp="$(wiz_graphql_with_retry "$summary_query" "{}")"

  printf '%s\n' "$resp" | "$WIZ_API_JQ_BIN" -c --arg timestamp "$timestamp" '{
    issues: {
      critical: .data.ic.totalCount,
      high: .data.ih.totalCount,
      medium: .data.im.totalCount,
      low: .data.il.totalCount,
      informational: .data.ii.totalCount
    },
    vulnerabilities: {
      critical: .data.vc.totalCount,
      high: .data.vh.totalCount,
      medium: .data.vm.totalCount,
      low: .data.vl.totalCount
    },
    configurationFindings: {
      critical: .data.cc.totalCount,
      high: .data.ch.totalCount,
      medium: .data.cm.totalCount,
      low: .data.cl.totalCount
    },
    timestamp: $timestamp
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
  WIZ_AUTH_AUDIENCE     (default: wiz-api)
  WIZ_API_TOKEN_CACHE   (default: /tmp/wiz-api-token.json)
  WIZ_API_MAX_PAGES     (default: 10)
  WIZ_API_TIMEOUT       (default: 30)
  WIZ_API_SKIP_VAULT    (default: 0)
EOF
}

main() {
  require_cmd "$WIZ_API_JQ_BIN"
  require_cmd "$WIZ_API_CURL_BIN"

  [[ "$WIZ_API_MAX_PAGES" =~ ^[0-9]+$ ]] || die "WIZ_API_MAX_PAGES must be an integer (got: ${WIZ_API_MAX_PAGES})"
  [[ "$WIZ_API_TIMEOUT" =~ ^[0-9]+$ ]] || die "WIZ_API_TIMEOUT must be an integer (got: ${WIZ_API_TIMEOUT})"

  [[ "$#" -ge 1 ]] || { usage; exit 1; }

  case "$1" in -h|--help|help) usage; return 0 ;; esac

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
    *) die "unknown command: $1" ;;
  esac
}

main "$@"
