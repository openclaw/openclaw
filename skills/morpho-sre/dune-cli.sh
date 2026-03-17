#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  dune-cli.sh <SUBCOMMAND> [ARGS...]

Subcommands:
  query create --name <name> --sql <sql> [--description <desc>] [--private] [--temp]
  query get <query-id>
  query update <query-id> [--name <name>] [--sql <sql>] [--tags <tags>]
  query run <query-id> [--param key=value] [--performance medium|large]
  query run-sql --sql <sql> [--param key=value]
  query archive <query-id>
  execution results <execution-id> [--limit N] [--offset N] [--timeout N]
  dataset search [--category <cat>] [--blockchain <chain>] [--schema <schema>]
  docs search --query <text> [--api-reference-only] [--code-only]
  usage [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD]

All subcommands accept: --output text|json (default: json)

Env:
  DUNE_API_KEY (required; falls back to Vault path secret/data/openclaw-sre)
  VAULT_ADDR (optional; enables Vault credential lookup)

Examples:
  dune-cli.sh query run-sql --sql "SELECT * FROM ethereum.transactions LIMIT 5"
  dune-cli.sh query run 12345 --param chain_id=1
  dune-cli.sh dataset search --blockchain ethereum --category decoded
  dune-cli.sh docs search --query "how to query NFT transfers"
EOF
}

die() {
  echo "dune-cli:error $*" >&2
  exit 1
}

detect_service_account_jwt() {
  local jwt_file="/var/run/secrets/kubernetes.io/serviceaccount/token"
  if [[ -f "$jwt_file" ]]; then
    printf '%s\n' "$jwt_file"
    return 0
  fi
  return 1
}

load_api_key_from_vault() {
  local vault_addr="${VAULT_ADDR:-}"
  local auth_path="${VAULT_KUBERNETES_AUTH_PATH:-kubernetes}"
  local role="${VAULT_KUBERNETES_ROLE:-incident-readonly-agent}"
  local secret_path="${DUNE_VAULT_SECRET_PATH:-secret/data/openclaw-sre}"

  [[ -n "$vault_addr" ]] || return 1

  local jwt_file
  jwt_file="$(detect_service_account_jwt)" || return 1
  local jwt
  jwt="$(tr -d '\r\n' <"$jwt_file")"
  [[ -n "$jwt" ]] || return 1

  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1

  local login_payload
  login_payload="$(jq -nc --arg role "$role" --arg jwt "$jwt" '{role:$role,jwt:$jwt}')"
  local login_json
  login_json="$(
    curl -fsS \
      -H 'Content-Type: application/json' \
      --data "$login_payload" \
      "${vault_addr%/}/v1/auth/${auth_path}/login"
  )" || return 1

  local vault_token
  vault_token="$(printf '%s\n' "$login_json" | jq -r '.auth.client_token // empty')"
  [[ -n "$vault_token" ]] || return 1

  local secret_json
  secret_json="$(
    curl -fsS \
      -H "X-Vault-Token: ${vault_token}" \
      "${vault_addr%/}/v1/${secret_path}"
  )" || return 1

  local api_key
  api_key="$(printf '%s\n' "$secret_json" | jq -r '.data.data.DUNE_API_KEY // empty')"
  [[ -n "$api_key" ]] || return 1

  DUNE_API_KEY="$api_key"
  DUNE_CREDENTIAL_SOURCE="vault:${secret_path}"
  return 0
}

load_api_key() {
  if [[ -n "${DUNE_API_KEY:-}" ]]; then
    DUNE_CREDENTIAL_SOURCE="env:DUNE_API_KEY"
    return 0
  fi
  if [[ "${DUNE_SKIP_VAULT:-0}" != "1" ]] && load_api_key_from_vault; then
    return 0
  fi
  die "missing DUNE_API_KEY; tried env DUNE_API_KEY and Vault path ${DUNE_VAULT_SECRET_PATH:-secret/data/openclaw-sre}"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

case "${1:-}" in
  -h|--help|help)
    usage
    exit 0
    ;;
  docs)
    # docs search does not require auth
    exec dune "$@"
    ;;
esac

load_api_key
export DUNE_API_KEY

# Default to JSON output for machine readability unless user specifies otherwise
has_output_flag=0
for arg in "$@"; do
  case "$arg" in
    -o|--output) has_output_flag=1 ;;
  esac
done

if [[ "$has_output_flag" -eq 0 ]]; then
  exec dune "$@" --output json
else
  exec dune "$@"
fi
