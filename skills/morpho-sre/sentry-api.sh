#!/usr/bin/env bash
set -euo pipefail

SENTRY_CURL_BIN="${SENTRY_CURL_BIN:-curl}"
SENTRY_JQ_BIN="${SENTRY_JQ_BIN:-jq}"
SENTRY_ENV_NAME=""
SENTRY_BASE_URL=""
SENTRY_AUTH_TOKEN=""
SENTRY_ORG_SLUG=""
SENTRY_PROJECT_SLUGS=""
SENTRY_PROJECT_MAP=""

usage() {
  cat <<'EOF'
Usage:
  sentry-api.sh <dev|prd> <GET-path>

Env per target:
  SENTRY_BASE_URL_DEV / SENTRY_BASE_URL_PRD
  SENTRY_AUTH_TOKEN_DEV / SENTRY_AUTH_TOKEN_PRD
  SENTRY_ORG_SLUG_DEV / SENTRY_ORG_SLUG_PRD
  SENTRY_PROJECT_SLUGS_DEV / SENTRY_PROJECT_SLUGS_PRD
  SENTRY_PROJECT_MAP_DEV / SENTRY_PROJECT_MAP_PRD
EOF
}

die() {
  printf 'sentry-api: %s\n' "$*" >&2
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

project_allowed() {
  local needle="$1"
  printf '%s\n' "$SENTRY_PROJECT_SLUGS" | tr ',' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | grep -Fx -- "$needle" >/dev/null 2>&1
}

project_id_allowed() {
  local needle="$1"
  if [[ -z "$SENTRY_PROJECT_MAP" ]]; then
    return 1
  fi

  printf '%s\n' "$SENTRY_PROJECT_MAP" | "$SENTRY_JQ_BIN" -e --arg needle "$needle" '
    if type != "object" then
      false
    else
      to_entries
      | any((.value.id // "" | tostring) == $needle)
    end
  ' >/dev/null
}

validate_query_params() {
  local path="$1"
  local query="${path#*\?}"
  local param
  local old_ifs

  [[ "$path" == *\?* ]] || return 0

  old_ifs="$IFS"
  IFS='&'
  for param in $query; do
    case "$param" in
      project=*)
        local value="${param#project=}"
        if [[ "$value" == *%* || "$value" == *\\* ]]; then
          die "blocked project query value (invalid characters): $value"
        fi
        [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]] || die "blocked project query value (disallowed format): $value"
        if ! project_allowed "$value" && ! project_id_allowed "$value"; then
          die "blocked project query value: $value"
        fi
        ;;
    esac
  done
  IFS="$old_ifs"
}

load_env() {
  local env_name="$1"
  SENTRY_ENV_NAME="$env_name"
  SENTRY_BASE_URL="$(resolve_env_value SENTRY_BASE_URL "$env_name")"
  SENTRY_AUTH_TOKEN="$(resolve_env_value SENTRY_AUTH_TOKEN "$env_name")"
  SENTRY_ORG_SLUG="$(resolve_env_value SENTRY_ORG_SLUG "$env_name")"
  SENTRY_PROJECT_SLUGS="$(resolve_env_value SENTRY_PROJECT_SLUGS "$env_name")"
  SENTRY_PROJECT_MAP="$(resolve_env_value SENTRY_PROJECT_MAP "$env_name")"

  require_cmd "$SENTRY_CURL_BIN"
  if [[ -n "$SENTRY_PROJECT_MAP" ]]; then
    require_cmd "$SENTRY_JQ_BIN"
  fi
  [[ -n "$SENTRY_BASE_URL" ]] || die "missing SENTRY_BASE_URL_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  [[ -n "$SENTRY_AUTH_TOKEN" ]] || die "missing SENTRY_AUTH_TOKEN_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  [[ -n "$SENTRY_ORG_SLUG" ]] || die "missing SENTRY_ORG_SLUG_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  [[ -n "$SENTRY_PROJECT_SLUGS" ]] || die "missing SENTRY_PROJECT_SLUGS_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
}

validate_path() {
  local path="$1"
  [[ "$path" == /api/0/* ]] || die "path must start with /api/0/ (got: $path)"

  local path_without_query="${path%%\?*}"
  [[ "$path_without_query" =~ ^/api/0/(projects/[^/]+/[^/?]+(/.*)?|organizations/[^/]+/(issues|projects)/?)$ ]] \
    || die "blocked unsupported sentry path: $path_without_query"

  local org_project_match
  org_project_match="$(printf '%s\n' "$path_without_query" | sed -nE 's#^/api/0/projects/([^/]+)/([^/?]+)(/.*)?$#\1 \2#p')"
  if [[ -n "$org_project_match" ]]; then
    local org_slug project_slug
    org_slug="${org_project_match%% *}"
    project_slug="${org_project_match##* }"
    [[ "$org_slug" == "$SENTRY_ORG_SLUG" ]] || die "blocked org slug in path: $org_slug (allowed: $SENTRY_ORG_SLUG)"
    project_allowed "$project_slug" || die "blocked project slug in path: $project_slug"
  fi

  local org_match
  org_match="$(printf '%s\n' "$path_without_query" | sed -nE 's#^/api/0/organizations/([^/]+)/.*#\1#p')"
  if [[ -n "$org_match" && "$org_match" != "$SENTRY_ORG_SLUG" ]]; then
    die "blocked organization path: $org_match (allowed: $SENTRY_ORG_SLUG)"
  fi

  validate_query_params "$path"
}

main() {
  if [[ $# -ne 2 ]]; then
    usage >&2
    exit 1
  fi

  case "$1" in
    dev|prd|prod) ;;
    *)
      die "first arg must be dev or prd"
      ;;
  esac

  if [[ "$1" == "prod" ]]; then
    set -- prd "$2"
  fi
  load_env "$1"
  validate_path "$2"

  exec "$SENTRY_CURL_BIN" -fsS \
    -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
    "${SENTRY_BASE_URL%/}$2"
}

main "$@"
