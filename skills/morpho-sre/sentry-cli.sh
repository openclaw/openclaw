#!/usr/bin/env bash
set -euo pipefail

SENTRY_ENV_NAME=""
SENTRY_BASE_URL=""
SENTRY_AUTH_TOKEN=""
SENTRY_ORG_SLUG=""
SENTRY_PROJECT_SLUGS=""
SENTRY_CLI_BIN="${SENTRY_CLI_BIN:-sentry-cli}"

usage() {
  cat <<'EOF'
Usage:
  sentry-cli.sh <dev|prd> <sentry-cli args...>

Env per target:
  SENTRY_BASE_URL_DEV / SENTRY_BASE_URL_PRD
  SENTRY_AUTH_TOKEN_DEV / SENTRY_AUTH_TOKEN_PRD
  SENTRY_ORG_SLUG_DEV / SENTRY_ORG_SLUG_PRD
  SENTRY_PROJECT_SLUGS_DEV / SENTRY_PROJECT_SLUGS_PRD
EOF
}

die() {
  printf 'sentry-cli-wrapper: %s\n' "$*" >&2
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

load_env() {
  local env_name="$1"
  SENTRY_ENV_NAME="$env_name"
  SENTRY_BASE_URL="$(resolve_env_value SENTRY_BASE_URL "$env_name")"
  SENTRY_AUTH_TOKEN="$(resolve_env_value SENTRY_AUTH_TOKEN "$env_name")"
  SENTRY_ORG_SLUG="$(resolve_env_value SENTRY_ORG_SLUG "$env_name")"
  SENTRY_PROJECT_SLUGS="$(resolve_env_value SENTRY_PROJECT_SLUGS "$env_name")"

  [[ -n "$SENTRY_BASE_URL" ]] || die "missing SENTRY_BASE_URL_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  [[ -n "$SENTRY_AUTH_TOKEN" ]] || die "missing SENTRY_AUTH_TOKEN_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  [[ -n "$SENTRY_ORG_SLUG" ]] || die "missing SENTRY_ORG_SLUG_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
  [[ -n "$SENTRY_PROJECT_SLUGS" ]] || die "missing SENTRY_PROJECT_SLUGS_$(printf '%s' "$env_name" | tr '[:lower:]' '[:upper:]')"
}

validate_args() {
  local args=("$@")
  local i=0
  while [[ $i -lt ${#args[@]} ]]; do
    case "${args[$i]}" in
      --org=*)
        [[ "${args[$i]#--org=}" == "$SENTRY_ORG_SLUG" ]] || die "blocked --org value"
        ;;
      --project=*)
        project_allowed "${args[$i]#--project=}" || die "blocked --project value"
        ;;
      --url|--url=*|--auth-token|--auth-token=*)
        die "blocked flag: ${args[$i]} — use env-scoped credentials only"
        ;;
      --org|-o)
        ((i += 1))
        [[ $i -lt ${#args[@]} ]] || die "missing value for --org/-o"
        [[ "${args[$i]}" == "$SENTRY_ORG_SLUG" ]] || die "blocked --org value"
        ;;
      --project|-p)
        ((i += 1))
        [[ $i -lt ${#args[@]} ]] || die "missing value for --project/-p"
        project_allowed "${args[$i]}" || die "blocked --project value"
        ;;
    esac
    ((i += 1))
  done
}

main() {
  if [[ $# -lt 2 ]]; then
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
    set -- prd "${@:2}"
  fi
  load_env "$1"
  shift

  require_cmd "$SENTRY_CLI_BIN"
  validate_args "$@"

  export SENTRY_URL="$SENTRY_BASE_URL"
  export SENTRY_AUTH_TOKEN
  export SENTRY_ORG="$SENTRY_ORG_SLUG"
  local first_project="${SENTRY_PROJECT_SLUGS%%,*}"
  first_project="$(trim "$first_project")"
  [[ -n "$first_project" ]] || die "could not extract default project from SENTRY_PROJECT_SLUGS"
  export SENTRY_PROJECT="$first_project"

  exec "$SENTRY_CLI_BIN" "$@"
}

main "$@"
