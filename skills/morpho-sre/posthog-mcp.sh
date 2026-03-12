#!/usr/bin/env bash
set -euo pipefail

POSTHOG_MCP_URL="${POSTHOG_MCP_URL:-https://mcp.posthog.com/sse}"
POSTHOG_MCP_CURL_BIN="${POSTHOG_MCP_CURL_BIN:-curl}"
POSTHOG_MCP_JQ_BIN="${POSTHOG_MCP_JQ_BIN:-jq}"
POSTHOG_MCP_NPX_BIN="${POSTHOG_MCP_NPX_BIN:-npx}"
POSTHOG_MCP_REMOTE_PACKAGE="${POSTHOG_MCP_REMOTE_PACKAGE:-mcp-remote@0.1.38}"
POSTHOG_MCP_ACTIVE_ENV=""
POSTHOG_MCP_ACTIVE_HOST=""
POSTHOG_MCP_ACTIVE_API_KEY=""
POSTHOG_MCP_ACTIVE_PROJECT_ID=""
POSTHOG_MCP_ACTIVE_PROJECT_MAP=""
POSTHOG_MCP_AUTH_HEADER=""
POSTHOG_MCP_REMOTE_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  posthog-mcp.sh <dev|prd> [run|--print-plan|--probe-auth]
  posthog-mcp.sh <dev|prd> --project-id <id> [run|--print-plan|--probe-auth]
  posthog-mcp.sh <dev|prd> --project-key <key> [run|--print-plan|--probe-auth]

Env per target:
  POSTHOG_HOST_DEV / POSTHOG_HOST_PRD
  POSTHOG_PERSONAL_API_KEY_DEV / POSTHOG_PERSONAL_API_KEY_PRD
  POSTHOG_PROJECT_ID_DEV / POSTHOG_PROJECT_ID_PRD
  POSTHOG_PROJECT_MAP_DEV / POSTHOG_PROJECT_MAP_PRD

Fallbacks:
  POSTHOG_HOST
  POSTHOG_API_KEY
EOF
}

die() {
  printf 'posthog-mcp: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

trim() {
  printf '%s' "$1" | awk '{$1=$1; print}'
}

resolve_env_value() {
  local prefix="$1"
  local env_name="$2"
  local suffix
  suffix="$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  local var_name="${prefix}_${suffix}"
  local value="${!var_name:-}"
  printf '%s' "$(trim "$value")"
}

resolve_first_nonempty() {
  local value=""
  for value in "$@"; do
    value="$(trim "$value")"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done
  printf '%s' ""
}

urlencode() {
  require_cmd "$POSTHOG_MCP_JQ_BIN"
  printf '%s' "$1" | "$POSTHOG_MCP_JQ_BIN" -sRr @uri
}

project_id_for_key() {
  local project_key="$1"
  [[ -n "$project_key" ]] || die "missing value for --project-key"
  [[ -n "$POSTHOG_MCP_ACTIVE_PROJECT_MAP" ]] || die "--project-key requires POSTHOG_PROJECT_MAP for ${POSTHOG_MCP_ACTIVE_ENV}"

  require_cmd "$POSTHOG_MCP_JQ_BIN"
  printf '%s\n' "$POSTHOG_MCP_ACTIVE_PROJECT_MAP" \
    | "$POSTHOG_MCP_JQ_BIN" -r --arg key "$project_key" '
      if type != "object" then
        error("project map must be an object")
      else
        .[$key].id // empty
      end
    ' || die "invalid POSTHOG project map JSON"
}

load_credentials() {
  local env_name="$1"
  local requested_project_id="${2:-}"
  POSTHOG_MCP_ACTIVE_ENV="$env_name"
  POSTHOG_MCP_ACTIVE_HOST="$(
    resolve_first_nonempty \
      "$(resolve_env_value POSTHOG_HOST "$env_name")" \
      "${POSTHOG_HOST:-}" \
      "https://eu.posthog.com"
  )"
  POSTHOG_MCP_ACTIVE_API_KEY="$(
    resolve_first_nonempty \
      "$(resolve_env_value POSTHOG_PERSONAL_API_KEY "$env_name")" \
      "${POSTHOG_API_KEY:-}"
  )"
  POSTHOG_MCP_ACTIVE_PROJECT_ID="$(resolve_env_value POSTHOG_PROJECT_ID "$env_name")"
  POSTHOG_MCP_ACTIVE_PROJECT_MAP="$(resolve_env_value POSTHOG_PROJECT_MAP "$env_name")"

  [[ -n "$POSTHOG_MCP_ACTIVE_HOST" ]] || die "missing POSTHOG_HOST_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]') / POSTHOG_HOST"
  [[ -n "$POSTHOG_MCP_ACTIVE_API_KEY" ]] || die "missing POSTHOG_PERSONAL_API_KEY_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]') / POSTHOG_API_KEY"

  if [[ -z "$requested_project_id" && -z "$POSTHOG_MCP_ACTIVE_PROJECT_ID" && -z "$POSTHOG_MCP_ACTIVE_PROJECT_MAP" ]]; then
    die "missing POSTHOG_PROJECT_ID_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]') or POSTHOG_PROJECT_MAP_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  fi

  POSTHOG_MCP_AUTH_HEADER="Bearer ${POSTHOG_MCP_ACTIVE_API_KEY}"
}

build_url() {
  local sep='?'
  local url="$POSTHOG_MCP_URL"
  url="${url}${sep}host=$(urlencode "$POSTHOG_MCP_ACTIVE_HOST")"
  sep='&'
  if [[ -n "$POSTHOG_MCP_ACTIVE_PROJECT_ID" ]]; then
    url="${url}${sep}project_id=$(urlencode "$POSTHOG_MCP_ACTIVE_PROJECT_ID")"
  fi
  url="${url}${sep}read_only=true"
  printf '%s\n' "$url"
}

build_remote_args() {
  local url
  url="$(build_url)"
  POSTHOG_MCP_REMOTE_ARGS=(
    "-y"
    "$POSTHOG_MCP_REMOTE_PACKAGE"
    "$url"
    "--header"
    "Authorization: ${POSTHOG_MCP_AUTH_HEADER}"
  )
}

print_plan() {
  require_cmd "$POSTHOG_MCP_JQ_BIN"
  build_remote_args
  local args_json
  args_json="$(
    printf '%s\n' "${POSTHOG_MCP_REMOTE_ARGS[@]}" \
      | "$POSTHOG_MCP_JQ_BIN" -Rsc '
          split("\n")[:-1]
          | map(
              if startswith("Authorization: Bearer ") then
                "Authorization: ${POSTHOG_MCP_AUTH_HEADER}"
              else
                .
              end
            )
        '
  )"
  "$POSTHOG_MCP_JQ_BIN" -nc \
    --arg envName "$POSTHOG_MCP_ACTIVE_ENV" \
    --arg command "$POSTHOG_MCP_NPX_BIN" \
    --arg url "$(build_url)" \
    --arg host "$POSTHOG_MCP_ACTIVE_HOST" \
    --arg projectId "$POSTHOG_MCP_ACTIVE_PROJECT_ID" \
    --arg projectMap "$POSTHOG_MCP_ACTIVE_PROJECT_MAP" \
    --argjson args "$args_json" \
    '{
      env: $envName,
      command: $command,
      args: $args,
      url: $url,
      host: $host,
      projectId: (if $projectId == "" then null else $projectId end),
      projectMapConfigured: ($projectMap != ""),
      credentialSource: ("env:" + $envName),
      envKeys: [
        "POSTHOG_PERSONAL_API_KEY_" + ($envName | ascii_upcase),
        "POSTHOG_PROJECT_ID_" + ($envName | ascii_upcase),
        "POSTHOG_PROJECT_MAP_" + ($envName | ascii_upcase),
        "POSTHOG_HOST_" + ($envName | ascii_upcase)
      ]
    }'
}

probe_auth() {
  require_cmd "$POSTHOG_MCP_CURL_BIN"
  require_cmd "$POSTHOG_MCP_JQ_BIN"
  local url response code body curl_rc temp_body
  local probe_url
  curl_rc=0
  temp_body="$(mktemp /tmp/posthog-mcp-probe-body.XXXXXX)"
  url="$(build_url)"
  probe_url="${POSTHOG_MCP_ACTIVE_HOST%/}/api/projects/?limit=1"
  response="$(
    "$POSTHOG_MCP_CURL_BIN" -sS -D - -o "$temp_body" \
      -H "Authorization: ${POSTHOG_MCP_AUTH_HEADER}" \
      "$probe_url"
  )" || curl_rc=$?
  code="$(printf '%s\n' "$response" | sed -n 's/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' | tail -n1)"
  if [[ -f "$temp_body" ]]; then
    body="$(tr -d '\r\n' <"$temp_body" | cut -c1-200)"
  else
    body=""
  fi
  rm -f "$temp_body"
  "$POSTHOG_MCP_JQ_BIN" -nc \
    --arg envName "$POSTHOG_MCP_ACTIVE_ENV" \
    --arg status "${code:-0}" \
    --argjson curlExitCode "$curl_rc" \
    --arg url "$probe_url" \
    --arg projectId "$POSTHOG_MCP_ACTIVE_PROJECT_ID" \
    --arg projectMap "$POSTHOG_MCP_ACTIVE_PROJECT_MAP" \
    --arg body "$body" \
    '{
      env: $envName,
      status: ($status | tonumber),
      ok: ((($status | tonumber) >= 200) and (($status | tonumber) < 300)),
      curlExitCode: $curlExitCode,
      url: $url,
      projectId: (if $projectId == "" then null else $projectId end),
      projectMapConfigured: ($projectMap != ""),
      bodyPreview: $body
    }'
}

main() {
  local requested_project_id=""
  local requested_project_key=""
  if [[ $# -lt 1 || $# -gt 4 ]]; then
    usage >&2
    exit 1
  fi

  local env_name="$1"
  local mode="run"
  case "$env_name" in
    dev|prd|prod) ;;
    *)
      die "first arg must be dev or prd"
      ;;
  esac

  shift
  if [[ $# -gt 0 ]]; then
    case "$1" in
      --project-id)
        [[ $# -ge 2 ]] || die "missing value for --project-id"
        requested_project_id="$(trim "$2")"
        shift 2
        ;;
      --project-key)
        [[ $# -ge 2 ]] || die "missing value for --project-key"
        requested_project_key="$(trim "$2")"
        shift 2
        ;;
    esac
  fi
  if [[ $# -gt 0 ]]; then
    mode="$1"
    shift
  fi
  [[ $# -eq 0 ]] || die "unexpected extra args"

  if [[ "$env_name" == "prod" ]]; then
    env_name="prd"
  fi
  load_credentials "$env_name" "$requested_project_id"
  if [[ -n "$requested_project_key" ]]; then
    POSTHOG_MCP_ACTIVE_PROJECT_ID="$(project_id_for_key "$requested_project_key")"
  elif [[ -n "$requested_project_id" ]]; then
    POSTHOG_MCP_ACTIVE_PROJECT_ID="$requested_project_id"
  fi
  build_remote_args

  case "$mode" in
    run)
      export POSTHOG_MCP_AUTH_HEADER
      exec "$POSTHOG_MCP_NPX_BIN" "${POSTHOG_MCP_REMOTE_ARGS[@]}"
      ;;
    --print-plan)
      print_plan
      ;;
    --probe-auth)
      probe_auth
      ;;
    *)
      die "unsupported mode: $mode"
      ;;
  esac
}

main "$@"
