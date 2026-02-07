#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_SECRETS=(
  MASTER_KEY
  REDPILL_API_KEY
  S3_BUCKET
  S3_ENDPOINT
  S3_PROVIDER
  S3_REGION
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
)

DEPLOY_ENV_FILE="${PHALA_DEPLOY_ENV_FILE:-/tmp/openclaw-phala-deploy.env}"
COMPOSE_FILE="${PHALA_COMPOSE_FILE:-${SCRIPT_DIR}/docker-compose.yml}"
SECRETS_RAW="${PHALA_DEPLOY_SECRETS:-}"
CVM_IDS_RAW="${PHALA_CVM_IDS:-}"
DRY_RUN=0
WAIT_FLAG=""

log() {
  printf '[cvm-rollout] %s\n' "$*"
}

die() {
  printf '[cvm-rollout] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [command] [options]

Commands:
  env        Render deploy env file from Redpill Vault (rv-exec)
  deploy     Deploy current compose to one or more CVM IDs
  rollout    Run env + deploy

Options:
  --cvm-ids <ids>       Comma-separated CVM IDs (overrides PHALA_CVM_IDS)
  --compose <path>      Compose file path (default: ${SCRIPT_DIR}/docker-compose.yml)
  --env-file <path>     Deploy env file path (default: /tmp/openclaw-phala-deploy.env)
  --secrets <keys>      Space-separated rv secret keys (default built-in list)
  --wait                Add --wait to phala deploy
  --dry-run             Print commands without executing
  -h, --help            Show this help

Environment:
  PHALA_CVM_IDS         Comma-separated CVM IDs
  PHALA_COMPOSE_FILE    Compose file path
  PHALA_DEPLOY_ENV_FILE Deploy env output path
  PHALA_DEPLOY_SECRETS  Space-separated secret keys for rv-exec

Examples:
  $(basename "$0") rollout --cvm-ids 0cd5...,1234...
  PHALA_CVM_IDS=0cd5... $(basename "$0") deploy --wait
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

trim() {
  local value="$1"
  value="${value#${value%%[![:space:]]*}}"
  value="${value%${value##*[![:space:]]}}"
  printf '%s' "$value"
}

split_csv() {
  local raw="$1"
  local IFS=','
  read -r -a items <<<"$raw"
  for item in "${items[@]}"; do
    item="$(trim "$item")"
    [[ -n "$item" ]] && printf '%s\n' "$item"
  done
}

build_secrets() {
  if [[ -n "$SECRETS_RAW" ]]; then
    # shellcheck disable=SC2206
    SECRETS=( $SECRETS_RAW )
  else
    SECRETS=("${DEFAULT_SECRETS[@]}")
  fi
  [[ ${#SECRETS[@]} -gt 0 ]] || die "no secrets configured"
}

render_env() {
  require_cmd rv-exec
  build_secrets
  mkdir -p "$(dirname "$DEPLOY_ENV_FILE")"

  local rv_dotenv_file="${DEPLOY_ENV_FILE}.rvexec"
  rm -f "$rv_dotenv_file"

  local cmd=(rv-exec --dotenv "$rv_dotenv_file")
  cmd+=("${SECRETS[@]}")
  cmd+=(-- bash -lc "cp '$rv_dotenv_file' '$DEPLOY_ENV_FILE' && chmod 600 '$DEPLOY_ENV_FILE' && test -s '$DEPLOY_ENV_FILE' && echo 'deploy env ready: $DEPLOY_ENV_FILE'")

  log "rendering deploy env -> $DEPLOY_ENV_FILE"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%q ' "${cmd[@]}"
    printf '\n'
    return 0
  fi

  "${cmd[@]}"
  rm -f "$rv_dotenv_file"
}

run_deploy() {
  require_cmd phala

  [[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
  [[ -n "$CVM_IDS_RAW" ]] || die "no CVM IDs provided (use --cvm-ids or PHALA_CVM_IDS)"

  mapfile -t CVM_IDS < <(split_csv "$CVM_IDS_RAW")
  [[ ${#CVM_IDS[@]} -gt 0 ]] || die "no valid CVM IDs parsed"

  for cvm_id in "${CVM_IDS[@]}"; do
    local cmd=(phala deploy --cvm-id "$cvm_id" -c "$COMPOSE_FILE" -e "$DEPLOY_ENV_FILE")
    [[ -n "$WAIT_FLAG" ]] && cmd+=("$WAIT_FLAG")

    log "deploying to CVM: $cvm_id"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf '%q ' "${cmd[@]}"
      printf '\n'
      continue
    fi

    "${cmd[@]}"
  done
}

COMMAND="rollout"

while [[ $# -gt 0 ]]; do
  case "$1" in
    env|deploy|rollout)
      COMMAND="$1"
      shift
      ;;
    --cvm-ids)
      CVM_IDS_RAW="${2:-}"
      shift 2
      ;;
    --compose)
      COMPOSE_FILE="${2:-}"
      shift 2
      ;;
    --env-file)
      DEPLOY_ENV_FILE="${2:-}"
      shift 2
      ;;
    --secrets)
      SECRETS_RAW="${2:-}"
      shift 2
      ;;
    --wait)
      WAIT_FLAG="--wait"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

case "$COMMAND" in
  env)
    render_env
    ;;
  deploy)
    run_deploy
    ;;
  rollout)
    render_env
    run_deploy
    ;;
  *)
    die "unsupported command: $COMMAND"
    ;;
esac
