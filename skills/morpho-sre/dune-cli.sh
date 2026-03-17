#!/usr/bin/env bash
set -euo pipefail

DUNE_CLI_BIN="${DUNE_CLI_BIN:-dune}"
DUNE_CREDENTIAL_SOURCE=""

usage() {
  cat <<'EOF'
Usage:
  dune-cli.sh [OPTIONS] <SUBCOMMAND> [ARGS...]

Wrapper options (must come before subcommand):
  --probe-auth     Show credential resolution without running a command
  -h, --help       Show this help

Subcommands (read-only):
  query get <query-id>
  query run <query-id> [--param key=value] [--performance medium|large]
  query run-sql --sql <sql> [--param key=value]
  execution results <execution-id> [--limit N] [--offset N] [--timeout N]
  dataset search [--category <cat>] [--blockchain <chain>] [--include-schema]
  dataset search-by-contract --contract-address <addr> [--include-schema]
  docs search --query <text> [--api-reference-only] [--code-only]
  usage [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD]

Subcommands (mutation — require DUNE_ALLOW_MUTATIONS=1):
  query create --name <name> --sql <sql> [--description <desc>] [--private] [--temp]
  query update <query-id> [--name <name>] [--sql <sql>] [--tags <tags>]
  query archive <query-id>

All subcommands accept: --output text|json (default: json)

Env:
  DUNE_API_KEY          (required; fallback: Vault cached token -> Vault K8s JWT auth)
  VAULT_ADDR            (optional; enables Vault credential lookup)
  VAULT_TOKEN           (optional; reuses existing Vault token)
  DUNE_VAULT_SECRET_PATH (optional; default: secret/data/openclaw-sre)
  DUNE_ALLOW_MUTATIONS  (optional; set to 1 to allow create/update/archive)
  DUNE_SKIP_VAULT       (optional; set to 1 to skip Vault lookup)

Examples:
  dune-cli.sh --probe-auth
  dune-cli.sh query run-sql --sql "SELECT * FROM ethereum.transactions LIMIT 5"
  dune-cli.sh query run 12345 --param chain_id=1
  dune-cli.sh dataset search --blockchain ethereum --category decoded --include-schema
  dune-cli.sh dataset search-by-contract --contract-address 0x1234...
  dune-cli.sh docs search --query "how to query NFT transfers"
EOF
}

die() {
  printf 'dune-cli:error %s\n' "$*" >&2
  exit 1
}

redact_key() {
  local key="${1:-}"
  if [[ ${#key} -gt 8 ]]; then
    printf '%s...%s' "${key:0:4}" "${key: -4}"
  elif [[ -n "$key" ]]; then
    printf '***'
  else
    printf '(empty)'
  fi
}

detect_service_account_jwt() {
  local jwt_file="/var/run/secrets/kubernetes.io/serviceaccount/token"
  if [[ -f "$jwt_file" && -s "$jwt_file" ]]; then
    printf '%s\n' "$jwt_file"
    return 0
  fi
  return 1
}

# Fetch secret from Vault using an existing VAULT_TOKEN (set by start-gateway.sh)
load_api_key_from_vault_token() {
  local vault_addr="${VAULT_ADDR:-}"
  local vault_token="${VAULT_TOKEN:-}"
  local secret_path="${DUNE_VAULT_SECRET_PATH:-secret/data/openclaw-sre}"

  [[ -n "$vault_addr" ]] || return 1
  [[ -n "$vault_token" ]] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1

  local secret_json
  secret_json="$(
    curl -fsS \
      -H "X-Vault-Token: ${vault_token}" \
      "${vault_addr%/}/v1/${secret_path}"
  )" || { echo "dune-cli:warning vault secret fetch failed at ${secret_path}" >&2; return 1; }

  local api_key
  api_key="$(printf '%s\n' "$secret_json" | jq -r '.data.data.DUNE_API_KEY // empty')"
  [[ -n "$api_key" ]] || { echo "dune-cli:warning DUNE_API_KEY not found in vault path ${secret_path}" >&2; return 1; }

  DUNE_API_KEY="$api_key"
  DUNE_CREDENTIAL_SOURCE="vault:${secret_path} (cached token)"
  return 0
}

# Fetch secret from Vault by authenticating via K8s JWT
load_api_key_from_vault_jwt() {
  local vault_addr="${VAULT_ADDR:-}"
  local auth_path="${VAULT_KUBERNETES_AUTH_PATH:-kubernetes}"
  local role="${VAULT_KUBERNETES_ROLE:-incident-readonly-agent}"
  local secret_path="${DUNE_VAULT_SECRET_PATH:-secret/data/openclaw-sre}"

  [[ -n "$vault_addr" ]] || return 1

  local jwt_file
  jwt_file="$(detect_service_account_jwt)" || { echo "dune-cli:warning K8s service account token not available" >&2; return 1; }
  local jwt
  jwt="$(tr -d '\r\n' <"$jwt_file")"
  [[ -n "$jwt" ]] || { echo "dune-cli:warning K8s service account token is empty" >&2; return 1; }

  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1

  local login_payload
  login_payload="$(jq -nc --arg role "$role" --arg jwt "$jwt" '{role:$role,jwt:$jwt}')" || {
    echo "dune-cli:warning failed to create vault login payload" >&2; return 1;
  }
  local login_json
  login_json="$(
    curl -fsS \
      -H 'Content-Type: application/json' \
      --data "$login_payload" \
      "${vault_addr%/}/v1/auth/${auth_path}/login"
  )" || { echo "dune-cli:warning vault JWT auth failed (role=${role}, auth_path=${auth_path})" >&2; return 1; }

  local vault_token
  vault_token="$(printf '%s\n' "$login_json" | jq -r '.auth.client_token // empty')"
  [[ -n "$vault_token" ]] || { echo "dune-cli:warning vault returned empty token" >&2; return 1; }

  local secret_json
  secret_json="$(
    curl -fsS \
      -H "X-Vault-Token: ${vault_token}" \
      "${vault_addr%/}/v1/${secret_path}"
  )" || { echo "dune-cli:warning vault secret fetch failed at ${secret_path}" >&2; return 1; }

  local api_key
  api_key="$(printf '%s\n' "$secret_json" | jq -r '.data.data.DUNE_API_KEY // empty')"
  [[ -n "$api_key" ]] || { echo "dune-cli:warning DUNE_API_KEY not found in vault path ${secret_path}" >&2; return 1; }

  DUNE_API_KEY="$api_key"
  DUNE_CREDENTIAL_SOURCE="vault:${secret_path} (jwt auth)"
  return 0
}

load_api_key() {
  # 1. Environment variable (highest priority)
  if [[ -n "${DUNE_API_KEY:-}" ]]; then
    DUNE_CREDENTIAL_SOURCE="env:DUNE_API_KEY"
    return 0
  fi

  if [[ "${DUNE_SKIP_VAULT:-0}" == "1" ]]; then
    die "missing DUNE_API_KEY (Vault lookup skipped via DUNE_SKIP_VAULT=1)"
  fi

  local vault_path="${DUNE_VAULT_SECRET_PATH:-secret/data/openclaw-sre}"

  # 2. Vault with existing token (fast path — reuses start-gateway.sh token)
  if [[ -n "${VAULT_ADDR:-}" ]]; then
    if load_api_key_from_vault_token; then
      return 0
    fi

    # 3. Vault with K8s JWT auth (slow path — re-authenticates)
    if load_api_key_from_vault_jwt; then
      return 0
    fi

    die "missing DUNE_API_KEY; env unset, Vault lookups failed at ${vault_path} (see warnings above)"
  fi

  die "missing DUNE_API_KEY; env unset and VAULT_ADDR not configured"
}

probe_auth() {
  printf 'dune-cli: credential probe\n'
  printf '  DUNE_API_KEY env:     %s\n' "$(if [[ -n "${DUNE_API_KEY:-}" ]]; then redact_key "$DUNE_API_KEY"; else echo "(not set)"; fi)"
  printf '  VAULT_ADDR:           %s\n' "${VAULT_ADDR:-(not set)}"
  printf '  VAULT_TOKEN:          %s\n' "$(if [[ -n "${VAULT_TOKEN:-}" ]]; then echo "set ($(redact_key "$VAULT_TOKEN"))"; else echo "(not set)"; fi)"
  printf '  DUNE_VAULT_SECRET_PATH: %s\n' "${DUNE_VAULT_SECRET_PATH:-secret/data/openclaw-sre}"
  printf '  DUNE_SKIP_VAULT:      %s\n' "${DUNE_SKIP_VAULT:-0}"
  printf '  DUNE_ALLOW_MUTATIONS: %s\n' "${DUNE_ALLOW_MUTATIONS:-0}"
  printf '  dune binary:          %s\n' "$(command -v "$DUNE_CLI_BIN" 2>/dev/null || echo "(not found)")"

  # Attempt resolution
  if load_api_key 2>/dev/null; then
    printf '  resolution:           OK (source: %s, key: %s)\n' "$DUNE_CREDENTIAL_SOURCE" "$(redact_key "$DUNE_API_KEY")"
  else
    printf '  resolution:           FAILED\n'
  fi
}

validate_args() {
  local args=("$@")
  local i=0
  while [[ $i -lt ${#args[@]} ]]; do
    case "${args[$i]}" in
      --api-key|--api-key=*)
        die "blocked flag: --api-key — use DUNE_API_KEY env or Vault credentials only"
        ;;
    esac
    ((i += 1))
  done
}

# Check if the subcommand is a mutation operation
check_mutation_guard() {
  # args: query create | query update | query archive
  if [[ $# -ge 2 && "$1" == "query" ]]; then
    case "$2" in
      create|update|archive)
        if [[ "${DUNE_ALLOW_MUTATIONS:-0}" != "1" ]]; then
          die "blocked mutation: 'query $2' requires DUNE_ALLOW_MUTATIONS=1 (read-only by default)"
        fi
        ;;
    esac
  fi
}

# --- main ---

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

case "${1:-}" in
  -h|--help|help)
    usage
    exit 0
    ;;
  --probe-auth)
    probe_auth
    exit 0
    ;;
  docs)
    # docs search does not require auth but still validate args
    validate_args "$@"
    exec "$DUNE_CLI_BIN" "$@"
    ;;
esac

validate_args "$@"
check_mutation_guard "$@"
load_api_key
export DUNE_API_KEY

# Default to JSON output for machine readability unless user specifies otherwise.
# Match all forms: -o, -ojson, --output, --output=json
has_output_flag=0
for arg in "$@"; do
  case "$arg" in
    -o|-o*|--output|--output=*) has_output_flag=1 ;;
  esac
done

if [[ "$has_output_flag" -eq 0 ]]; then
  exec "$DUNE_CLI_BIN" "$@" --output json
else
  exec "$DUNE_CLI_BIN" "$@"
fi
