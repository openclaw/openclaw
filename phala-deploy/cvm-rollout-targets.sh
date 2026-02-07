#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OPENCLAW_CVM_IDS="${PHALA_OPENCLAW_CVM_IDS:-}"
OPENCLAW_COMPOSE_FILE="${PHALA_OPENCLAW_COMPOSE_FILE:-${SCRIPT_DIR}/docker-compose.yml}"
OPENCLAW_DEPLOY_ENV_FILE="${PHALA_OPENCLAW_DEPLOY_ENV_FILE:-/tmp/openclaw-phala-deploy.env}"
OPENCLAW_DEPLOY_SECRETS="${PHALA_OPENCLAW_DEPLOY_SECRETS:-MASTER_KEY REDPILL_API_KEY S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY}"

MUX_CVM_IDS="${PHALA_MUX_CVM_IDS:-}"
MUX_COMPOSE_FILE="${PHALA_MUX_COMPOSE_FILE:-${SCRIPT_DIR}/mux-server-compose.yml}"
MUX_DEPLOY_ENV_FILE="${PHALA_MUX_DEPLOY_ENV_FILE:-/tmp/mux-phala-deploy.env}"
MUX_DEPLOY_SECRETS="${PHALA_MUX_DEPLOY_SECRETS:-MUX_REGISTER_KEY TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN}"

WAIT_FLAG=0
DRY_RUN=0
SKIP_ROLE_CHECK=0

log() {
  printf '[cvm-rollout-targets] %s\n' "$*"
}

die() {
  printf '[cvm-rollout-targets] ERROR: %s\n' "$*" >&2
  exit 1
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

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") <target> [options]

Targets:
  openclaw   Deploy only OpenClaw CVM(s)
  mux        Deploy only mux-server CVM(s)
  all        Deploy OpenClaw CVM(s) then mux-server CVM(s)

Options:
  --wait             Pass --wait to phala deploy
  --dry-run          Print commands without executing
  --skip-role-check  Skip CVM-name safety checks (not recommended)
  -h, --help         Show this help

Environment:
  PHALA_OPENCLAW_CVM_IDS          Comma-separated OpenClaw CVM IDs
  PHALA_OPENCLAW_COMPOSE_FILE     OpenClaw compose (default: phala-deploy/docker-compose.yml)
  PHALA_OPENCLAW_DEPLOY_ENV_FILE  OpenClaw deploy env file
  PHALA_OPENCLAW_DEPLOY_SECRETS   OpenClaw vault keys
  PHALA_MUX_CVM_IDS               Comma-separated mux CVM IDs
  PHALA_MUX_COMPOSE_FILE          mux compose (default: phala-deploy/mux-server-compose.yml)
  PHALA_MUX_DEPLOY_ENV_FILE       mux deploy env file
  PHALA_MUX_DEPLOY_SECRETS        mux vault keys

Examples:
  $(basename "$0") openclaw --wait
  $(basename "$0") mux --wait
  $(basename "$0") all --wait
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

is_mux_name() {
  local name="$1"
  [[ "${name,,}" == *mux* ]]
}

read_cvm_name() {
  local cvm_id="$1"
  phala cvms get "$cvm_id" --json | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      process.stdout.write(String(parsed.name || ""));
    });
  '
}

validate_role_ids() {
  local role="$1"
  local ids_raw="$2"
  [[ -n "$ids_raw" ]] || die "no CVM IDs configured for role ${role}"

  if [[ "$SKIP_ROLE_CHECK" -eq 1 ]]; then
    return 0
  fi

  mapfile -t ids < <(split_csv "$ids_raw")
  [[ ${#ids[@]} -gt 0 ]] || die "no valid CVM IDs parsed for role ${role}"
  for id in "${ids[@]}"; do
    local cvm_name
    cvm_name="$(read_cvm_name "$id")"
    [[ -n "$cvm_name" ]] || die "failed to resolve CVM name for ${id}"
    if [[ "$role" == "openclaw" ]] && is_mux_name "$cvm_name"; then
      die "role=openclaw rejects CVM ${id} (${cvm_name}) because it looks like mux"
    fi
    if [[ "$role" == "mux" ]] && ! is_mux_name "$cvm_name"; then
      die "role=mux rejects CVM ${id} (${cvm_name}) because name does not contain mux"
    fi
  done
}

run_role() {
  local role="$1"
  local cvm_ids compose_file env_file secrets

  case "$role" in
    openclaw)
      cvm_ids="$OPENCLAW_CVM_IDS"
      compose_file="$OPENCLAW_COMPOSE_FILE"
      env_file="$OPENCLAW_DEPLOY_ENV_FILE"
      secrets="$OPENCLAW_DEPLOY_SECRETS"
      ;;
    mux)
      cvm_ids="$MUX_CVM_IDS"
      compose_file="$MUX_COMPOSE_FILE"
      env_file="$MUX_DEPLOY_ENV_FILE"
      secrets="$MUX_DEPLOY_SECRETS"
      ;;
    *)
      die "unsupported role: $role"
      ;;
  esac

  [[ -f "$compose_file" ]] || die "compose file not found for role ${role}: ${compose_file}"
  validate_role_ids "$role" "$cvm_ids"

  local cmd=("${SCRIPT_DIR}/cvm-rollout.sh" rollout
    --cvm-ids "$cvm_ids"
    --compose "$compose_file"
    --env-file "$env_file"
    --secrets "$secrets"
  )
  [[ "$WAIT_FLAG" -eq 1 ]] && cmd+=(--wait)
  [[ "$DRY_RUN" -eq 1 ]] && cmd+=(--dry-run)

  log "deploy role=${role} compose=${compose_file} cvm_ids=${cvm_ids}"
  "${cmd[@]}"
}

TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    openclaw|mux|all)
      TARGET="$1"
      shift
      ;;
    --wait)
      WAIT_FLAG=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-role-check)
      SKIP_ROLE_CHECK=1
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

[[ -n "$TARGET" ]] || {
  usage
  exit 1
}

require_cmd phala
require_cmd node

case "$TARGET" in
  openclaw)
    run_role openclaw
    ;;
  mux)
    run_role mux
    ;;
  all)
    run_role openclaw
    run_role mux
    ;;
esac
