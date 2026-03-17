# Wiz GraphQL API Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a direct Wiz GraphQL API client (`wiz-api.sh`) to the SRE skill, enabling the bot to query vulnerabilities, issues, cloud config, Kubernetes posture, runtime events, and resource inventory.

**Architecture:** Single self-contained bash script with OAuth2 client credentials auth, file-based token caching, and pre-built subcommands for each Wiz data domain. Credential loading duplicated from `wiz-mcp.sh` for single-file deployment. All output is JSON to stdout, errors to stderr.

**Tech Stack:** Bash, curl, jq. OAuth2 client credentials flow against `https://auth.app.wiz.io/oauth/token`. GraphQL queries against `https://api.eu26.app.wiz.io/graphql`.

**Spec:** `docs/superpowers/specs/2026-03-17-wiz-api-integration-design.md`

---

## File Map

| File                                   | Action                                      | Responsibility                                                                    |
| -------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `skills/morpho-sre/wiz-api.sh`         | Create                                      | Main script — OAuth2 auth, token caching, GraphQL execution, all subcommands      |
| `test/sre-substrate/test-wiz-api.sh`   | Create                                      | Integration tests — mock curl, credential fallback, auth, pagination, subcommands |
| `skills/morpho-sre/SKILL.md`           | Modify (lines 105, 137, after 169)          | Add Wiz API path entry + documentation section                                    |
| `skills/morpho-sre/knowledge-index.md` | Modify (after `wiz-mcp.sh` entry, ~line 87) | Add `wiz-api.sh` entry to Helper Scripts                                          |

---

### Task 1: Core Scaffold + Credential Loading

**Files:**

- Create: `skills/morpho-sre/wiz-api.sh`
- Create: `test/sre-substrate/test-wiz-api.sh`

- [ ] **Step 1: Create `wiz-api.sh` with core helpers and credential loading**

Create `skills/morpho-sre/wiz-api.sh`:

```bash
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
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x skills/morpho-sre/wiz-api.sh`

- [ ] **Step 3: Create test scaffold with credential tests**

Create `test/sre-substrate/test-wiz-api.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/skills/morpho-sre/wiz-api.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

assert_ok() {
  local desc="$1"
  if eval "$2"; then
    PASS=$((PASS + 1))
    printf '  PASS: %s\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL: %s\n' "$desc" >&2
  fi
}

printf '=== test-wiz-api: credential loading ===\n'

# --- env credentials ---
plan_env="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='test-client-id'
  export WIZ_CLIENT_SECRET='test-client-secret'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-env.json"
  "${SCRIPT_PATH}" --print-plan 2>/dev/null
)"

assert_ok "env: credentialSource is env" \
  "printf '%s' '$plan_env' | jq -e '.credentialSource == \"env\"' >/dev/null"
assert_ok "env: does not leak client_secret" \
  "! printf '%s' '$plan_env' | grep -q 'test-client-secret'"

# --- vault credentials ---
printf '%s\n' 'jwt-token' >"${TMP}/jwt"

cat >"${TMP}/mock-curl-vault.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    */v1/auth/kubernetes/login)
      printf '{"auth":{"client_token":"vault-tok"}}\n'
      exit 0
      ;;
    */v1/secret/data/wiz/api-token)
      printf '{"data":{"data":{"client_id":"vault-cid","client_secret":"vault-csec"}}}\n'
      exit 0
      ;;
  esac
done
# Default: auth token endpoint (will be added later)
printf '{"access_token":"mock-token","expires_in":3600,"token_type":"Bearer"}\n'
CURL_EOF
chmod +x "${TMP}/mock-curl-vault.sh"

plan_vault="$(
  export VAULT_ADDR='https://vault.test'
  export VAULT_KUBERNETES_AUTH_PATH='kubernetes'
  export VAULT_KUBERNETES_ROLE='test-role'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-vault.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_VAULT_JWT_FILE="${TMP}/jwt"
  export WIZ_API_TOKEN_CACHE="${TMP}/token-vault.json"
  export WIZ_CLIENT_ID='stale-env-id'
  export WIZ_CLIENT_SECRET='stale-env-secret'
  "${SCRIPT_PATH}" --print-plan 2>/dev/null
)"

assert_ok "vault: credentialSource is vault" \
  "printf '%s' '$plan_vault' | jq -e '.credentialSource == \"vault:secret/data/wiz/api-token\"' >/dev/null"
assert_ok "vault: does not leak secrets" \
  "! printf '%s' '$plan_vault' | grep -q 'vault-csec'"

# --- missing credentials fail ---
if (
  unset WIZ_CLIENT_ID WIZ_CLIENT_SECRET VAULT_ADDR
  export WIZ_API_SKIP_VAULT=1
  export WIZ_API_TOKEN_CACHE="${TMP}/token-missing.json"
  "${SCRIPT_PATH}" --print-plan >/dev/null 2>&1
); then
  FAIL=$((FAIL + 1))
  printf '  FAIL: missing creds should fail\n' >&2
else
  PASS=$((PASS + 1))
  printf '  PASS: missing creds fail as expected\n'
fi

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
```

- [ ] **Step 4: Make test executable**

Run: `chmod +x test/sre-substrate/test-wiz-api.sh`

- [ ] **Step 5: Run credential tests to verify they fail (--print-plan not yet implemented)**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: FAIL (cmd_print_plan not defined yet)

- [ ] **Step 6: Implement `cmd_print_plan`**

Add before `main()` in `skills/morpho-sre/wiz-api.sh`:

```bash
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
```

- [ ] **Step 7: Run credential tests — should pass now**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
scripts/committer "feat(sre): add wiz-api.sh scaffold with credential loading and tests" \
  skills/morpho-sre/wiz-api.sh test/sre-substrate/test-wiz-api.sh
```

---

### Task 2: OAuth2 Authentication + Token Caching

**Files:**

- Modify: `skills/morpho-sre/wiz-api.sh`
- Modify: `test/sre-substrate/test-wiz-api.sh`

- [ ] **Step 1: Add auth tests to test file**

Append to `test/sre-substrate/test-wiz-api.sh` (before the Results line):

```bash
printf '\n=== test-wiz-api: OAuth2 auth + token caching ===\n'

# --- mock curl that handles both auth and GraphQL ---
cat >"${TMP}/mock-curl-auth.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    */oauth/token)
      printf '{"access_token":"test-bearer-abc","expires_in":3600,"token_type":"Bearer"}\n'
      exit 0
      ;;
  esac
done
# GraphQL endpoint — echo back for inspection
printf '{"data":{"ok":true}}\n'
CURL_EOF
chmod +x "${TMP}/mock-curl-auth.sh"

# --- authenticate and probe ---
probe_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='auth-test-id'
  export WIZ_CLIENT_SECRET='auth-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-auth.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-auth.json"
  "${SCRIPT_PATH}" --probe-auth 2>/dev/null
)"

assert_ok "auth: probe returns ok=true" \
  "printf '%s' '$probe_result' | jq -e '.ok == true' >/dev/null"
assert_ok "auth: probe returns credentialSource" \
  "printf '%s' '$probe_result' | jq -e '.credentialSource == \"env\"' >/dev/null"

# --- token cache file created with correct perms ---
assert_ok "auth: token cache file exists" \
  "[[ -f '${TMP}/token-auth.json' ]]"
assert_ok "auth: token cache file has 600 perms" \
  "[[ \"\$(stat -f '%Lp' '${TMP}/token-auth.json' 2>/dev/null || stat -c '%a' '${TMP}/token-auth.json' 2>/dev/null)\" == '600' ]]"

# --- token cache is valid JSON with expires_at ---
assert_ok "auth: token cache has expires_at" \
  "jq -e '.expires_at > 0' '${TMP}/token-auth.json' >/dev/null"
```

- [ ] **Step 2: Run tests to verify they fail (auth not yet implemented)**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: credential tests PASS, auth tests FAIL

- [ ] **Step 3: Implement OAuth2 auth functions**

Add to `skills/morpho-sre/wiz-api.sh` after `load_credentials()`:

```bash
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
      --data-urlencode "audience=wiz-api" \
      "$WIZ_AUTH_URL"
  )" || die "auth request failed"

  access_token="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r '.access_token // empty')"
  [[ -n "$access_token" ]] || die "auth response missing access_token"
  expires_in="$(printf '%s\n' "$response" | "$WIZ_API_JQ_BIN" -r '.expires_in // 3600')"

  save_cached_token "$access_token" "$expires_in"
  WIZ_API_BEARER_TOKEN="$access_token"
}

ensure_token() {
  if load_cached_token; then
    return 0
  fi
  authenticate
}
```

- [ ] **Step 4: Implement `cmd_probe_auth`**

Add after the auth functions:

```bash
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
```

- [ ] **Step 5: Run tests — should pass now**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(sre): add OAuth2 auth + token caching to wiz-api.sh" \
  skills/morpho-sre/wiz-api.sh test/sre-substrate/test-wiz-api.sh
```

---

### Task 3: GraphQL Execution + 401 Retry

**Files:**

- Modify: `skills/morpho-sre/wiz-api.sh`
- Modify: `test/sre-substrate/test-wiz-api.sh`

- [ ] **Step 1: Add GraphQL + query tests**

Append to test file (before Results line):

```bash
printf '\n=== test-wiz-api: GraphQL execution ===\n'

# --- mock curl that returns GraphQL data ---
cat >"${TMP}/mock-curl-gql.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
http_code_file=""
output_file=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    */oauth/token)
      printf '{"access_token":"gql-token","expires_in":3600,"token_type":"Bearer"}\n'
      exit 0
      ;;
    -o)
      i=$((i + 1))
      output_file="${args[$i]}"
      ;;
    -w)
      i=$((i + 1))
      http_code_file="__write_code__"
      ;;
  esac
  i=$((i + 1))
done
# GraphQL response
response='{"data":{"issues":{"nodes":[{"id":"iss-1","severity":"CRITICAL"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}'
if [[ -n "$output_file" ]]; then
  printf '%s' "$response" >"$output_file"
  printf '200'
else
  printf '%s\n' "$response"
fi
CURL_EOF
chmod +x "${TMP}/mock-curl-gql.sh"

query_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='gql-test-id'
  export WIZ_CLIENT_SECRET='gql-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-gql.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-gql.json"
  "${SCRIPT_PATH}" query '{ issues(first: 5) { nodes { id severity } pageInfo { hasNextPage endCursor } } }' 2>/dev/null
)"

assert_ok "query: returns data" \
  "printf '%s' '$query_result' | jq -e '.data.issues.nodes[0].id == \"iss-1\"' >/dev/null"
```

- [ ] **Step 2: Run tests to verify query test fails**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: credential + auth PASS, query FAIL

- [ ] **Step 3: Implement `wiz_graphql` and `wiz_graphql_with_retry`**

Add after `ensure_token()`:

```bash
wiz_graphql_with_retry() {
  local query="$1"
  local vars_json="${2:-{}}"
  local response error_msg tmp_body http_code payload

  ensure_token

  payload="$("$WIZ_API_JQ_BIN" -nc \
    --arg query "$query" \
    --argjson variables "$vars_json" \
    '{ query: $query, variables: $variables }'
  )" || die "failed to build GraphQL payload"

  tmp_body="$(mktemp /tmp/wiz-api-body.XXXXXX)"

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

    tmp_body="$(mktemp /tmp/wiz-api-body.XXXXXX)"
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
```

- [ ] **Step 4: Implement `cmd_query`**

```bash
cmd_query() {
  local query_input="${1:-}"
  local vars_json="${2:-'{}'}"
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
```

- [ ] **Step 5: Run tests — should pass**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(sre): add GraphQL execution + 401 retry to wiz-api.sh" \
  skills/morpho-sre/wiz-api.sh test/sre-substrate/test-wiz-api.sh
```

---

### Task 4: Pagination

**Files:**

- Modify: `skills/morpho-sre/wiz-api.sh`
- Modify: `test/sre-substrate/test-wiz-api.sh`

- [ ] **Step 1: Add pagination tests**

Append to test file (before Results line):

```bash
printf '\n=== test-wiz-api: pagination ===\n'

# --- mock curl that returns two pages ---
cat >"${TMP}/mock-curl-paginate.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
data_payload=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) output_file="$arg" ;;
    --data) data_payload="$arg" ;;
  esac
  prev="$arg"
done

# Auth endpoint
for arg in "$@"; do
  case "$arg" in
    */oauth/token)
      printf '{"access_token":"pag-token","expires_in":3600}\n'
      exit 0
      ;;
  esac
done

# Check if after cursor is set
if printf '%s' "$data_payload" | jq -e '.variables.after == "cursor-1"' >/dev/null 2>&1; then
  response='{"data":{"issuesV2":{"nodes":[{"id":"iss-2"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}'
else
  response='{"data":{"issuesV2":{"nodes":[{"id":"iss-1"}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-1"}}}}'
fi

if [[ -n "$output_file" ]]; then
  printf '%s' "$response" >"$output_file"
  printf '200'
else
  printf '%s\n' "$response"
fi
CURL_EOF
chmod +x "${TMP}/mock-curl-paginate.sh"

paginated_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='pag-test-id'
  export WIZ_CLIENT_SECRET='pag-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-paginate.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-pag.json"
  "${SCRIPT_PATH}" issues --first 1 2>/dev/null
)"

assert_ok "pagination: merged 2 nodes" \
  "printf '%s' '$paginated_result' | jq -e 'length == 2' >/dev/null"
assert_ok "pagination: first node is iss-1" \
  "printf '%s' '$paginated_result' | jq -e '.[0].id == \"iss-1\"' >/dev/null"
assert_ok "pagination: second node is iss-2" \
  "printf '%s' '$paginated_result' | jq -e '.[1].id == \"iss-2\"' >/dev/null"
```

- [ ] **Step 2: Run tests to verify pagination test fails**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: pagination tests FAIL

- [ ] **Step 3: Implement `paginated_query`**

Add after `wiz_graphql_with_retry()`:

```bash
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
      page_vars="$(printf '%s\n' "$vars_json" | "$WIZ_API_JQ_BIN" -c --arg after "$cursor" '. + {after: $after}')"
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
```

- [ ] **Step 4: Implement `cmd_issues` (first subcommand, needed for pagination test)**

Add a stub `cmd_issues` to validate the pagination test passes:

```bash
cmd_issues() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local severity="" status="" issue_type="" entity_type=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --severity)    severity="$2"; shift 2 ;;
      --status)      status="$2"; shift 2 ;;
      --type)        issue_type="$2"; shift 2 ;;
      --entity-type) entity_type="$2"; shift 2 ;;
      --first)       first="$2"; shift 2 ;;
      --max-pages)   max_pages="$2"; shift 2 ;;
      *) die "unknown issues flag: $1" ;;
    esac
  done

  local filter_parts=()
  if [[ -n "$severity" ]]; then
    filter_parts+=("severity: [$(printf '%s' "$severity" | tr ',' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')]")
  fi
  if [[ -n "$status" ]]; then
    filter_parts+=("status: [$(printf '%s' "$status" | tr ',' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')]")
  fi
  if [[ -n "$issue_type" ]]; then
    filter_parts+=("type: [$(printf '%s' "$issue_type" | tr ',' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')]")
  fi
  if [[ -n "$entity_type" ]]; then
    filter_parts+=("entityType: [$(printf '%s' "$entity_type" | tr ',' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')]")
  fi

  local filter_clause=""
  if [[ "${#filter_parts[@]}" -gt 0 ]]; then
    filter_clause="filterBy: { $(IFS=', '; printf '%s' "${filter_parts[*]}") },"
  fi

  local query
  query="query(\$first: Int, \$after: String) {
    issuesV2(first: \$first, after: \$after, ${filter_clause} orderBy: { field: SEVERITY, direction: DESC }) {
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
  }"

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" '{ first: $first }')"
  paginated_query "$query" "$vars_json" '.data.issuesV2' "$max_pages"
}
```

- [ ] **Step 5: Run tests — should pass**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(sre): add pagination + issues subcommand to wiz-api.sh" \
  skills/morpho-sre/wiz-api.sh test/sre-substrate/test-wiz-api.sh
```

---

### Task 5: Remaining Pre-built Subcommands

**Files:**

- Modify: `skills/morpho-sre/wiz-api.sh`
- Modify: `test/sre-substrate/test-wiz-api.sh`

- [ ] **Step 1: Add subcommand filter tests**

Append to test file (before Results line). These tests verify that filters get embedded in the GraphQL payload:

```bash
printf '\n=== test-wiz-api: subcommands ===\n'

# --- mock curl that echoes back the request payload ---
cat >"${TMP}/mock-curl-echo.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
data_payload=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) output_file="$arg" ;;
    --data) data_payload="$arg" ;;
  esac
  prev="$arg"
done
for arg in "$@"; do
  case "$arg" in
    */oauth/token)
      printf '{"access_token":"echo-token","expires_in":3600}\n'
      exit 0
      ;;
  esac
done
# Return the query payload as data so tests can inspect it
response="{\"data\":{\"vulnerabilityFindings\":{\"nodes\":[],\"pageInfo\":{\"hasNextPage\":false}},\"issues\":{\"nodes\":[],\"pageInfo\":{\"hasNextPage\":false}},\"graphSearch\":{\"nodes\":[],\"pageInfo\":{\"hasNextPage\":false}},\"configurationFindings\":{\"nodes\":[],\"pageInfo\":{\"hasNextPage\":false}},\"kubernetesClusterQueries\":{\"clusters\":{\"nodes\":[],\"pageInfo\":{\"hasNextPage\":false}}},\"securityEvents\":{\"nodes\":[],\"pageInfo\":{\"hasNextPage\":false}},\"_query\":$(printf '%s' "$data_payload" | jq -c '.query // ""')}}"
if [[ -n "$output_file" ]]; then
  printf '%s' "$response" >"$output_file"
  printf '200'
else
  printf '%s\n' "$response"
fi
CURL_EOF
chmod +x "${TMP}/mock-curl-echo.sh"

run_subcmd() {
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='sub-test-id'
  export WIZ_CLIENT_SECRET='sub-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-echo.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-sub-$1.json"
  "${SCRIPT_PATH}" "$@" 2>/dev/null
}

# Each subcommand should return a JSON array
for subcmd in vulns issues inventory cloud-config k8s runtime; do
  result="$(run_subcmd "$subcmd")"
  assert_ok "${subcmd}: returns JSON array" \
    "printf '%s' '$result' | jq -e 'type == \"array\"' >/dev/null"
done

# Summary returns an object
summary_result="$(run_subcmd summary)"
assert_ok "summary: returns JSON object" \
  "printf '%s' '$summary_result' | jq -e 'type == \"object\"' >/dev/null"
assert_ok "summary: has timestamp" \
  "printf '%s' '$summary_result' | jq -e '.timestamp' >/dev/null"

printf '\n=== test-wiz-api: 401 retry ===\n'

# --- mock curl that returns 401 first, then 200 on retry ---
cat >"${TMP}/mock-curl-401.sh" <<'CURL_EOF'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) output_file="$arg" ;;
  esac
  prev="$arg"
done
for arg in "$@"; do
  case "$arg" in
    */oauth/token)
      printf '{"access_token":"retry-token-%s","expires_in":3600}\n' "$(date +%s%N)"
      exit 0
      ;;
  esac
done
# Track call count via file
count_file="/tmp/wiz-api-401-count"
count=0
if [[ -f "$count_file" ]]; then count="$(cat "$count_file")"; fi
count=$((count + 1))
printf '%s' "$count" >"$count_file"
if [[ "$count" -eq 1 ]]; then
  if [[ -n "$output_file" ]]; then
    printf '{"error":"unauthorized"}' >"$output_file"
    printf '401'
  fi
else
  if [[ -n "$output_file" ]]; then
    printf '{"data":{"test":true}}' >"$output_file"
    printf '200'
  fi
fi
CURL_EOF
chmod +x "${TMP}/mock-curl-401.sh"

rm -f /tmp/wiz-api-401-count
retry_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='retry-id'
  export WIZ_CLIENT_SECRET='retry-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-401.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-retry.json"
  "${SCRIPT_PATH}" query '{ test }' 2>/dev/null
)"
rm -f /tmp/wiz-api-401-count

assert_ok "401 retry: returns data after retry" \
  "printf '%s' '$retry_result' | jq -e '.data.test == true' >/dev/null"

printf '\n=== test-wiz-api: query @file ===\n'

printf '{ fileTest(first: 1) { nodes { id } } }' >"${TMP}/test-query.graphql"
file_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='file-test-id'
  export WIZ_CLIENT_SECRET='file-test-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-auth.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-file.json"
  "${SCRIPT_PATH}" query "@${TMP}/test-query.graphql" 2>/dev/null
)"

assert_ok "query @file: returns data" \
  "printf '%s' '$file_result' | jq -e '.data' >/dev/null"

printf '\n=== test-wiz-api: max-pages limit ===\n'

# Using the pagination mock — with --max-pages 1, should only get 1 node even though hasNextPage=true
maxpages_result="$(
  export WIZ_API_SKIP_VAULT=1
  export WIZ_CLIENT_ID='maxpages-id'
  export WIZ_CLIENT_SECRET='maxpages-secret'
  export WIZ_API_CURL_BIN="${TMP}/mock-curl-paginate.sh"
  export WIZ_API_JQ_BIN='jq'
  export WIZ_API_TOKEN_CACHE="${TMP}/token-maxpages.json"
  "${SCRIPT_PATH}" issues --first 1 --max-pages 1 2>/dev/null
)"

assert_ok "max-pages: returns only 1 node with --max-pages 1" \
  "printf '%s' '$maxpages_result' | jq -e 'length == 1' >/dev/null"
```

- [ ] **Step 2: Run tests — subcommand tests should fail**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: subcommand tests FAIL (functions not yet defined)

- [ ] **Step 3: Implement `cmd_vulns`**

```bash
cmd_vulns() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local severity="" image="" cve="" has_fix=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --severity)  severity="$2"; shift 2 ;;
      --image)     image="$2"; shift 2 ;;
      --cve)       cve="$2"; shift 2 ;;
      --has-fix)   has_fix="true"; shift ;;
      --first)     first="$2"; shift 2 ;;
      --max-pages) max_pages="$2"; shift 2 ;;
      *) die "unknown vulns flag: $1" ;;
    esac
  done

  local filter_parts=()
  if [[ -n "$severity" ]]; then
    filter_parts+=("severity: [$(printf '%s' "$severity" | tr ',' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')]")
  fi
  if [[ -n "$image" ]]; then
    filter_parts+=("imageName: \"${image}\"")
  fi
  if [[ -n "$cve" ]]; then
    filter_parts+=("name: \"${cve}\"")
  fi
  if [[ "$has_fix" == "true" ]]; then
    filter_parts+=("hasFix: true")
  fi

  local filter_clause=""
  if [[ "${#filter_parts[@]}" -gt 0 ]]; then
    filter_clause="filterBy: { $(IFS=', '; printf '%s' "${filter_parts[*]}") },"
  fi

  local query
  query="query(\$first: Int, \$after: String) {
    vulnerabilityFindings(first: \$first, after: \$after, ${filter_clause} orderBy: { field: SEVERITY, direction: DESC }) {
      nodes {
        id
        name
        severity
        score
        hasFix
        fixedVersion
        detailedName
        version
        vulnerableAsset { id name type }
        firstDetectedAt
        lastDetectedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }"

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" '{ first: $first }')"
  paginated_query "$query" "$vars_json" '.data.vulnerabilityFindings' "$max_pages"
}
```

- [ ] **Step 4: Implement `cmd_inventory`**

```bash
cmd_inventory() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local res_type="" subscription="" search=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --type)         res_type="$2"; shift 2 ;;
      --subscription) subscription="$2"; shift 2 ;;
      --search)       search="$2"; shift 2 ;;
      --first)        first="$2"; shift 2 ;;
      --max-pages)    max_pages="$2"; shift 2 ;;
      *) die "unknown inventory flag: $1" ;;
    esac
  done

  local where_parts=()
  if [[ -n "$res_type" ]]; then
    where_parts+=("{type: {equals: [\"${res_type}\"]}}")
  fi
  if [[ -n "$subscription" ]]; then
    where_parts+=("{subscription: {equals: [\"${subscription}\"]}}")
  fi
  if [[ -n "$search" ]]; then
    where_parts+=("{name: {contains: \"${search}\"}}")
  fi

  local where_clause="[]"
  if [[ "${#where_parts[@]}" -gt 0 ]]; then
    where_clause="[$(IFS=','; printf '%s' "${where_parts[*]}")]"
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
```

- [ ] **Step 5: Implement `cmd_cloud_config`**

```bash
cmd_cloud_config() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local severity="" rule="" status=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --severity)  severity="$2"; shift 2 ;;
      --rule)      rule="$2"; shift 2 ;;
      --status)    status="$2"; shift 2 ;;
      --first)     first="$2"; shift 2 ;;
      --max-pages) max_pages="$2"; shift 2 ;;
      *) die "unknown cloud-config flag: $1" ;;
    esac
  done

  local filter_parts=()
  if [[ -n "$severity" ]]; then
    filter_parts+=("severity: [$(printf '%s' "$severity" | tr ',' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')]")
  fi
  if [[ -n "$rule" ]]; then
    filter_parts+=("rule: \"${rule}\"")
  fi
  if [[ -n "$status" ]]; then
    filter_parts+=("status: [$(printf '%s' "$status" | tr ',' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')]")
  fi

  local filter_clause=""
  if [[ "${#filter_parts[@]}" -gt 0 ]]; then
    filter_clause="filterBy: { $(IFS=', '; printf '%s' "${filter_parts[*]}") },"
  fi

  local query
  query="query(\$first: Int, \$after: String) {
    configurationFindings(first: \$first, after: \$after, ${filter_clause} orderBy: { field: SEVERITY, direction: DESC }) {
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
  }"

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" '{ first: $first }')"
  paginated_query "$query" "$vars_json" '.data.configurationFindings' "$max_pages"
}
```

- [ ] **Step 6: Implement `cmd_k8s`**

```bash
cmd_k8s() {
  local first=20 max_pages="$WIZ_API_MAX_PAGES"
  local cluster=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --cluster)   cluster="$2"; shift 2 ;;
      --first)     first="$2"; shift 2 ;;
      --max-pages) max_pages="$2"; shift 2 ;;
      *) die "unknown k8s flag: $1" ;;
    esac
  done

  local filter_clause=""
  if [[ -n "$cluster" ]]; then
    filter_clause="filterBy: { search: \"${cluster}\" },"
  fi

  local query
  query="query(\$first: Int, \$after: String) {
    kubernetesClusterQueries {
      clusters(first: \$first, after: \$after, ${filter_clause}) {
        nodes {
          id
          name
          cloudAccount { name }
          issueAnalytics { criticalCount highCount mediumCount lowCount informationalCount }
          podCount
          serviceCount
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }"

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" '{ first: $first }')"
  paginated_query "$query" "$vars_json" '.data.kubernetesClusterQueries.clusters' "$max_pages"
}
```

- [ ] **Step 7: Implement `cmd_runtime`**

```bash
cmd_runtime() {
  local first=50 max_pages="$WIZ_API_MAX_PAGES"
  local severity=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --severity)  severity="$2"; shift 2 ;;
      --first)     first="$2"; shift 2 ;;
      --max-pages) max_pages="$2"; shift 2 ;;
      *) die "unknown runtime flag: $1" ;;
    esac
  done

  local filter_parts=()
  if [[ -n "$severity" ]]; then
    filter_parts+=("severity: [$(printf '%s' "$severity" | tr ',' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')]")
  fi

  local filter_clause=""
  if [[ "${#filter_parts[@]}" -gt 0 ]]; then
    filter_clause="filterBy: { $(IFS=', '; printf '%s' "${filter_parts[*]}") },"
  fi

  local query
  query="query(\$first: Int, \$after: String) {
    securityEvents(first: \$first, after: \$after, ${filter_clause} orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        id
        severity
        type
        description
        sourceResource { id name type }
        createdAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }"

  local vars_json
  vars_json="$("$WIZ_API_JQ_BIN" -nc --argjson first "$first" '{ first: $first }')"
  paginated_query "$query" "$vars_json" '.data.securityEvents' "$max_pages"
}
```

- [ ] **Step 8: Run tests — should pass**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
scripts/committer "feat(sre): add vulns, inventory, cloud-config, k8s, runtime subcommands" \
  skills/morpho-sre/wiz-api.sh test/sre-substrate/test-wiz-api.sh
```

---

### Task 6: Summary Subcommand

**Files:**

- Modify: `skills/morpho-sre/wiz-api.sh`

- [ ] **Step 1: Implement `cmd_summary`**

```bash
cmd_summary() {
  local issues_query='query {
    issueAnalytics {
      criticalCount
      highCount
      mediumCount
      lowCount
      informationalCount
    }
  }'

  local vulns_query='query {
    vulnerabilityFindingAggregates {
      criticalCount
      highCount
      mediumCount
      lowCount
    }
  }'

  local config_query='query {
    configurationFindingAggregates {
      criticalCount
      highCount
      mediumCount
      lowCount
    }
  }'

  local issues_resp vulns_resp config_resp timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  issues_resp="$(wiz_graphql_with_retry "$issues_query" '{}')"
  vulns_resp="$(wiz_graphql_with_retry "$vulns_query" '{}')"
  config_resp="$(wiz_graphql_with_retry "$config_query" '{}')"

  "$WIZ_API_JQ_BIN" -nc \
    --argjson issues "$issues_resp" \
    --argjson vulns "$vulns_resp" \
    --argjson config "$config_resp" \
    --arg timestamp "$timestamp" \
    '{
      issues: {
        critical: ($issues.data.issueAnalytics.criticalCount // 0),
        high: ($issues.data.issueAnalytics.highCount // 0),
        medium: ($issues.data.issueAnalytics.mediumCount // 0),
        low: ($issues.data.issueAnalytics.lowCount // 0),
        informational: ($issues.data.issueAnalytics.informationalCount // 0)
      },
      vulnerabilities: {
        critical: ($vulns.data.vulnerabilityFindingAggregates.criticalCount // 0),
        high: ($vulns.data.vulnerabilityFindingAggregates.highCount // 0),
        medium: ($vulns.data.vulnerabilityFindingAggregates.mediumCount // 0),
        low: ($vulns.data.vulnerabilityFindingAggregates.lowCount // 0)
      },
      configurationFindings: {
        critical: ($config.data.configurationFindingAggregates.criticalCount // 0),
        high: ($config.data.configurationFindingAggregates.highCount // 0),
        medium: ($config.data.configurationFindingAggregates.mediumCount // 0),
        low: ($config.data.configurationFindingAggregates.lowCount // 0)
      },
      timestamp: $timestamp
    }'
}
```

Note: The exact GraphQL operation names (`issueAnalytics`, `vulnerabilityFindingsSummary`, `configurationFindingsSummary`) will be validated against the live Wiz schema. If the schema uses different names, update the queries accordingly — the output shape stays the same.

- [ ] **Step 2: Run all tests**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
scripts/committer "feat(sre): add summary subcommand to wiz-api.sh" \
  skills/morpho-sre/wiz-api.sh test/sre-substrate/test-wiz-api.sh
```

---

### Task 7: SKILL.md + knowledge-index.md Updates

**Files:**

- Modify: `skills/morpho-sre/SKILL.md:105` (add path after wiz-mcp.sh entry)
- Modify: `skills/morpho-sre/SKILL.md:137` (add to helper scripts list)
- Modify: `skills/morpho-sre/SKILL.md` (add new section after line 169, after Wiz MCP section)
- Modify: `skills/morpho-sre/knowledge-index.md:87` (add entry after wiz-mcp.sh)

- [ ] **Step 1: Add Wiz API path to SKILL.md Paths section**

In `skills/morpho-sre/SKILL.md`, after line 105 (`Wiz MCP launcher`), add:

```
- Wiz API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh`
```

- [ ] **Step 2: Add wiz-api.sh to helper scripts list**

In `skills/morpho-sre/SKILL.md`, after line 137 (`wiz-mcp.sh`), add:

```
  - `wiz-api.sh`
```

- [ ] **Step 3: Add Wiz API documentation section to SKILL.md**

In `skills/morpho-sre/SKILL.md`, after the Wiz MCP section (after line 169), add:

````markdown
## Wiz API (Direct GraphQL)

- `wiz-api.sh` authenticates via OAuth2 client credentials and queries the Wiz
  GraphQL API directly at `https://api.eu26.app.wiz.io/graphql`.
- Credential resolution: Vault `secret/wiz/api-token` > `WIZ_CLIENT_ID`/`WIZ_CLIENT_SECRET`.
- Uses the same Vault secret as `wiz-mcp.sh` — no separate credentials needed.
- Token is cached at `/tmp/wiz-api-token.json` (chmod 600) and auto-refreshed.
- Pre-built subcommands auto-paginate (default max 10 pages).
- Raw `query` subcommand does not auto-paginate.
- Manual checks:

```bash
# Probe auth
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh --probe-auth | jq

# Show config (redacted)
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh --print-plan | jq

# Raw GraphQL query
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh query '{ issues(first: 5) { nodes { id severity } } }'

# Vulnerabilities - critical + high, with known fix
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh vulns --severity critical,high --has-fix

# Issues - open critical
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh issues --severity critical --status open

# Cloud config findings
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh cloud-config --severity critical,high

# Kubernetes cluster posture
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh k8s

# Runtime security events
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh runtime --severity critical,high

# Full posture summary (counts by severity)
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh summary | jq
```
````

````

- [ ] **Step 4: Add entry to knowledge-index.md**

In `skills/morpho-sre/knowledge-index.md`, after line 87 (after the `wiz-mcp.sh` entry), add:

```markdown
- `wiz-api.sh`
  Direct Wiz GraphQL API client. OAuth2 auth with file-based token caching.
  Queries vulnerabilities, issues, cloud config, Kubernetes posture, runtime
  events, and resource inventory. Uses the same Vault credentials as wiz-mcp.sh.
````

- [ ] **Step 5: Commit**

```bash
scripts/committer "docs(sre): document wiz-api.sh in SKILL.md and knowledge-index.md" \
  skills/morpho-sre/SKILL.md skills/morpho-sre/knowledge-index.md
```

---

### Task 8: Validate Against Live API

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/florian/morpho/openclaw-sre && bash test/sre-substrate/test-wiz-api.sh`
Expected: All PASS

- [ ] **Step 2: Probe live auth (requires WIZ_CLIENT_ID/SECRET in env or Vault)**

Run: `WIZ_API_SKIP_VAULT=1 bash skills/morpho-sre/wiz-api.sh --probe-auth | jq`
Expected: `{ "ok": true, "credentialSource": "env", ... }`

- [ ] **Step 3: Test live summary**

Run: `WIZ_API_SKIP_VAULT=1 bash skills/morpho-sre/wiz-api.sh summary | jq`

If any GraphQL operation name is wrong (the Wiz schema may differ), the error message will indicate which query failed. Fix the query and re-test. The summary subcommand aggregation queries are the most likely to need schema adjustment.

- [ ] **Step 4: Test live issues query**

Run: `WIZ_API_SKIP_VAULT=1 bash skills/morpho-sre/wiz-api.sh issues --severity CRITICAL --first 5 | jq`

- [ ] **Step 5: Fix any schema mismatches discovered during live validation**

If live queries return errors, update the GraphQL queries in the relevant `cmd_*` functions. Common fixes:

- Operation name spelling (`issuesV2` vs `issues`, field casing)
- Filter field names (`filterBy` structure varies by query type)
- Response path differences

After fixes, re-run: `bash test/sre-substrate/test-wiz-api.sh`

- [ ] **Step 6: Commit any schema fixes**

```bash
scripts/committer "fix(sre): adjust wiz-api.sh queries to match live Wiz GraphQL schema" \
  skills/morpho-sre/wiz-api.sh
```
