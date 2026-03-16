#!/usr/bin/env bash
set -euo pipefail

GRAPHQL_URL="${SINGLE_VAULT_GRAPHQL_URL:-https://api.morpho.org/graphql}"
RPC_URL="${SINGLE_VAULT_RPC_URL:-}"
CURL_TIMEOUT_SECONDS="${SINGLE_VAULT_CURL_TIMEOUT_SECONDS:-20}"

ADDRESS=""
CHAIN_ID=""
CONTROL_ADDRESS=""
QUERY=""
QUERY_FILE=""
VARIABLES_JSON=""
VARIABLES_FILE=""
LIST_QUERY_FILE=""
TRANSACTIONS_QUERY_FILE=""
PRINT_PLAN=0

usage() {
  cat <<'EOF'
Usage:
  single-vault-graphql-evidence.sh \
    --address 0x... \
    --chain-id 999 \
    (--query 'query { ... }' | --query-file /tmp/query.graphql) \
    [--variables-json '{"address":"0x...","chainId":999}' | --variables-file /tmp/variables.json] \
    [--control-address 0x...] \
    [--rpc-url https://...] \
    [--list-query-file /tmp/list.graphql] \
    [--transactions-query-file /tmp/transactions.graphql] \
    [--print-plan]

Captures a compact evidence bundle for one-address GraphQL incidents:
- exact query replay
- one same-chain control replay
- public-surface split (`vaultV2ByAddress`, `vaultV2s`, `vaultV2transactions`)
- optional direct RPC facts via `cast`

Environment:
- `SINGLE_VAULT_GRAPHQL_URL` overrides the GraphQL endpoint (default: https://api.morpho.org/graphql)
- `SINGLE_VAULT_RPC_URL` overrides the optional direct RPC endpoint (must use HTTPS)
- `SINGLE_VAULT_CURL_TIMEOUT_SECONDS` overrides curl `--max-time` (default: 20)
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_readable_file() {
  local label="${1:?label required}"
  local file_path="${2:?file path required}"
  [[ -r "$file_path" ]] || {
    printf '%s not readable: %s\n' "$label" "$file_path" >&2
    exit 2
  }
}

require_evm_address() {
  local label="${1:?label required}"
  local address="${2:?address required}"
  [[ "$address" =~ ^0x[a-fA-F0-9]{40}$ ]] || {
    printf '%s must be a valid Ethereum address (0x + 40 hex chars)\n' "$label" >&2
    exit 2
  }
}

require_https_url() {
  local label="${1:?label required}"
  local url="${2:?url required}"
  [[ "$url" =~ ^https://[^[:space:]]+$ ]] || {
    printf '%s must use HTTPS: %s\n' "$label" "$url" >&2
    exit 2
  }
}

json_is_valid() {
  local json_text="${1:?json text required}"
  jq -e . >/dev/null 2>&1 <<<"$json_text"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --address)
      ADDRESS="${2:?address required}"
      shift 2
      ;;
    --chain-id)
      CHAIN_ID="${2:?chain id required}"
      shift 2
      ;;
    --control-address)
      CONTROL_ADDRESS="${2:?control address required}"
      shift 2
      ;;
    --query)
      QUERY="${2:?query required}"
      shift 2
      ;;
    --query-file)
      QUERY_FILE="${2:?query file required}"
      shift 2
      ;;
    --variables-json)
      VARIABLES_JSON="${2:?variables json required}"
      shift 2
      ;;
    --variables-file)
      VARIABLES_FILE="${2:?variables file required}"
      shift 2
      ;;
    --list-query-file)
      LIST_QUERY_FILE="${2:?list query file required}"
      shift 2
      ;;
    --transactions-query-file)
      TRANSACTIONS_QUERY_FILE="${2:?transactions query file required}"
      shift 2
      ;;
    --rpc-url)
      RPC_URL="${2:?rpc url required}"
      shift 2
      ;;
    --print-plan)
      PRINT_PLAN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown arg: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd curl
require_cmd jq
require_https_url "graphql url" "$GRAPHQL_URL"
if [[ -n "$RPC_URL" ]]; then
  require_https_url "rpc url" "$RPC_URL"
fi

[[ -n "$ADDRESS" ]] || {
  printf 'address is required\n' >&2
  exit 2
}
require_evm_address "address" "$ADDRESS"
if [[ -n "$CONTROL_ADDRESS" ]]; then
  require_evm_address "control address" "$CONTROL_ADDRESS"
fi
[[ -n "$CHAIN_ID" ]] || {
  printf 'chain id is required\n' >&2
  exit 2
}
[[ "$CHAIN_ID" =~ ^(0|[1-9][0-9]*)$ ]] || {
  printf 'chain id must be numeric without leading zeros\n' >&2
  exit 2
}
# Morpho GraphQL uses GraphQL `Int`, so reject ids the API cannot encode.
# GraphQL `Int` is a signed 32-bit integer, and chain ids in this helper must
# stay positive.
[[ "$CHAIN_ID" -ge 1 && "$CHAIN_ID" -le 2147483647 ]] || {
  printf 'chain id must be between 1 and 2147483647 (GraphQL Int limit)\n' >&2
  exit 2
}

if [[ -n "$QUERY_FILE" ]]; then
  require_readable_file "query file" "$QUERY_FILE"
  QUERY="$(cat -- "$QUERY_FILE")"
fi

[[ -n "$QUERY" ]] || {
  printf 'query or query-file is required\n' >&2
  exit 2
}

if [[ -n "$VARIABLES_FILE" ]]; then
  require_readable_file "variables file" "$VARIABLES_FILE"
  VARIABLES_JSON="$(cat -- "$VARIABLES_FILE")"
fi

if [[ -z "$VARIABLES_JSON" ]]; then
  VARIABLES_JSON="$(jq -nc --arg address "$ADDRESS" --argjson chainId "$CHAIN_ID" '{address: $address, chainId: $chainId}')"
fi

LIST_QUERY_DEFAULT='query SingleVaultList($addresses: [String!], $chainIds: [Int!]) { vaultV2s(where: { address_in: $addresses, chainId_in: $chainIds }) { items { address name apy netApy totalAssets totalSupply sharePrice } } }'
TRANSACTIONS_QUERY_DEFAULT='query SingleVaultTransactions($address: String!, $chainId: Int!) { vaultV2transactions(where: { vaultAddress_in: [$address], chainId_in: [$chainId] }, first: 1) { items { hash type timestamp } } }'
BY_ADDRESS_QUERY='query SingleVaultByAddress($address: String!, $chainId: Int!) { vaultV2ByAddress(address: $address, chainId: $chainId) { address name apy netApy maxApy maxRate totalAssets totalSupply sharePrice } }'

if [[ "$PRINT_PLAN" -eq 1 ]]; then
  jq -nc \
    --arg graphql_url "$GRAPHQL_URL" \
    --arg address "$ADDRESS" \
    --argjson chain_id "$CHAIN_ID" \
    --arg control_address "$CONTROL_ADDRESS" \
    --arg has_rpc "$( [[ -n "$RPC_URL" ]] && printf yes || printf no )" \
    '{
      graphql_url: $graphql_url,
      address: $address,
      chain_id: $chain_id,
      control_address: (if $control_address == "" then null else $control_address end),
      probes: [
        "exact_query_replay",
        "minimal_by_address",
        "vaultV2s_address_in",
        "vaultV2transactions",
        "same_chain_control",
        (if $has_rpc == "yes" then "direct_rpc" else "direct_rpc_skipped" end)
      ]
    }'
  exit 0
fi

graphql_request() {
  (
    local query_text="${1:?query required}"
    local variables_text="${2:?variables required}"
    local response_file http_code

    json_is_valid "$variables_text" || {
      printf 'variables json must be valid JSON\n' >&2
      exit 1
    }

    response_file="$(mktemp)"
    trap "rm -f -- '$response_file'" EXIT INT TERM
    if ! http_code="$(
      jq -nc --arg query "$query_text" --argjson variables "$variables_text" '{query: $query, variables: $variables}' \
        | curl -sS \
            --max-time "$CURL_TIMEOUT_SECONDS" \
            -H 'content-type: application/json' \
            --data @- \
            --output "$response_file" \
            --write-out '%{http_code}' \
            --url "$GRAPHQL_URL"
    )"; then
      exit 1
    fi
    [[ "$http_code" =~ ^[0-9]{3}$ ]] || {
      printf 'curl did not report an HTTP status\n' >&2
      exit 1
    }
    cat -- "$response_file"
  )
}

response_summary() {
  local name="${1:?name required}"
  local response="${2:?response required}"
  if ! jq -e . >/dev/null 2>&1 <<<"$response"; then
    jq -nc \
      --arg name "$name" \
      '{name: $name, ok: "invalid_json_response", error_count: 1, first_error: "response was not valid JSON", data: null}'
    return 0
  fi
  jq -nc \
    --arg name "$name" \
    --argjson response "$response" \
    '{
      name: $name,
      ok: (if ($response.errors // []) | length == 0 then "yes" else "partial_or_error" end),
      error_count: (($response.errors // []) | length),
      first_error: (($response.errors // [])[0].message // null),
      data: ($response.data // null)
    }'
}

run_probe() {
  (
    local name="${1:?name required}"
    local query_text="${2:?query required}"
    local variables_text="${3:?variables required}"
    local raw stderr_file err
    stderr_file="$(mktemp)"
    trap "rm -f -- '$stderr_file'" EXIT INT TERM
    if raw="$(graphql_request "$query_text" "$variables_text" 2>"$stderr_file")"; then
      response_summary "$name" "$raw"
      exit 0
    fi
    err="$(cat -- "$stderr_file")"
    jq -nc \
      --arg name "$name" \
      --arg err "$err" \
      '{
        name: $name,
        ok: "request_failed",
        error_count: 1,
        first_error: (if $err == "" then "request_failed" else $err end),
        data: null
      }'
  )
}

same_chain_control_variables() {
  jq -nc --arg address "$CONTROL_ADDRESS" --argjson chainId "$CHAIN_ID" '{address: $address, chainId: $chainId}'
}

list_variables() {
  jq -nc --arg address "$ADDRESS" --argjson chainId "$CHAIN_ID" '{addresses: [$address], chainIds: [$chainId]}'
}

run_cast_probe() {
  (
    local selector="${1:?selector required}"
    local value stderr_file err status
    stderr_file="$(mktemp)"
    trap "rm -f -- '$stderr_file'" EXIT INT TERM
    if value="$(cast call --rpc-url "$RPC_URL" -- "$ADDRESS" "$selector" 2>"$stderr_file")"; then
      err=""
      status="ok"
    else
      value=""
      err="$(cat -- "$stderr_file")"
      status="failed"
    fi
    jq -nc \
      --arg status "$status" \
      --arg value "$value" \
      --arg err "$err" \
      '{
        status: $status,
        value: (if $value == "" then null else $value end),
        error: (if $err == "" then null else $err end)
      }'
  )
}

sanitize_graphql_probe() {
  local name="${1:?name required}"
  local probe_json="${2:?probe json required}"
  if jq -e . >/dev/null 2>&1 <<<"$probe_json"; then
    printf '%s\n' "$probe_json"
    return 0
  fi
  jq -nc \
    --arg name "$name" \
    '{name: $name, ok: "probe_output_invalid", error_count: 1, first_error: "probe output was not valid JSON", data: null}'
}

sanitize_rpc_probe() {
  local probe_json="${1:?probe json required}"
  if jq -e . >/dev/null 2>&1 <<<"$probe_json"; then
    printf '%s\n' "$probe_json"
    return 0
  fi
  jq -nc \
    '{
      status: "failed",
      totalAssets: null,
      totalSupply: null,
      totalAssetsError: null,
      totalSupplyError: null,
      first_error: "probe output was not valid JSON"
    }'
}

if [[ -n "$LIST_QUERY_FILE" ]]; then
  require_readable_file "list query file" "$LIST_QUERY_FILE"
  LIST_QUERY_DEFAULT="$(cat -- "$LIST_QUERY_FILE")"
fi

if [[ -n "$TRANSACTIONS_QUERY_FILE" ]]; then
  require_readable_file "transactions query file" "$TRANSACTIONS_QUERY_FILE"
  TRANSACTIONS_QUERY_DEFAULT="$(cat -- "$TRANSACTIONS_QUERY_FILE")"
fi

control_probe='{"name":"same_chain_control","ok":"skipped","error_count":0,"first_error":null,"data":null}'
if [[ -n "$CONTROL_ADDRESS" ]]; then
  control_probe="$(run_probe "same_chain_control" "$BY_ADDRESS_QUERY" "$(same_chain_control_variables)")"
fi

exact_probe="$(run_probe "exact_query_replay" "$QUERY" "$VARIABLES_JSON")"
by_address_probe="$(run_probe "minimal_by_address" "$BY_ADDRESS_QUERY" "$(jq -nc --arg address "$ADDRESS" --argjson chainId "$CHAIN_ID" '{address: $address, chainId: $chainId}')")"
list_probe="$(run_probe "vaultV2s_address_in" "$LIST_QUERY_DEFAULT" "$(list_variables)")"
transactions_probe="$(run_probe "vaultV2transactions" "$TRANSACTIONS_QUERY_DEFAULT" "$(jq -nc --arg address "$ADDRESS" --argjson chainId "$CHAIN_ID" '{address: $address, chainId: $chainId}')")"

rpc_probe='{"status":"skipped","note":"rpc_url_missing_or_cast_unavailable"}'
if [[ -n "$RPC_URL" ]] && command -v cast >/dev/null 2>&1; then
  total_assets_probe="$(run_cast_probe 'totalAssets()(uint256)')"
  total_supply_probe="$(run_cast_probe 'totalSupply()(uint256)')"
  rpc_probe="$(jq -nc \
    --argjson total_assets "$total_assets_probe" \
    --argjson total_supply "$total_supply_probe" \
    '{
      status: (if $total_assets.value != null or $total_supply.value != null then "ok" else "failed" end),
      totalAssets: $total_assets.value,
      totalSupply: $total_supply.value,
      totalAssetsError: $total_assets.error,
      totalSupplyError: $total_supply.error,
      first_error: ($total_assets.error // $total_supply.error)
    }')"
fi

control_probe="$(sanitize_graphql_probe "same_chain_control" "$control_probe")"
exact_probe="$(sanitize_graphql_probe "exact_query_replay" "$exact_probe")"
by_address_probe="$(sanitize_graphql_probe "minimal_by_address" "$by_address_probe")"
list_probe="$(sanitize_graphql_probe "vaultV2s_address_in" "$list_probe")"
transactions_probe="$(sanitize_graphql_probe "vaultV2transactions" "$transactions_probe")"
rpc_probe="$(sanitize_rpc_probe "$rpc_probe")"

jq -nc \
  --arg graphql_url "$GRAPHQL_URL" \
  --arg address "$ADDRESS" \
  --argjson chain_id "$CHAIN_ID" \
  --arg control_address "$CONTROL_ADDRESS" \
  --argjson exact_probe "$exact_probe" \
  --argjson by_address_probe "$by_address_probe" \
  --argjson list_probe "$list_probe" \
  --argjson transactions_probe "$transactions_probe" \
  --argjson control_probe "$control_probe" \
  --argjson rpc_probe "$rpc_probe" \
  'def graph_probe_captured($probe): $probe.ok == "yes" or $probe.ok == "partial_or_error";
  {
    status: "ok",
    graphql_url: $graphql_url,
    address: $address,
    chain_id: $chain_id,
    control_address: (if $control_address == "" then null else $control_address end),
    probes: {
      exact_query_replay: $exact_probe,
      minimal_by_address: $by_address_probe,
      vaultV2s_address_in: $list_probe,
      vaultV2transactions: $transactions_probe,
      same_chain_control: $control_probe,
      direct_rpc: $rpc_probe
    },
    summary: {
      exact_query_replay: $exact_probe.ok,
      healthy_control_check: $control_probe.ok,
      public_surface_split: (if graph_probe_captured($by_address_probe) and graph_probe_captured($list_probe) and graph_probe_captured($transactions_probe) then "captured" else "failed" end),
      direct_rpc_check: ($rpc_probe.status // "skipped")
    },
    evidence_line: (
      "address=" + $address
      + " chainId=" + ($chain_id | tostring)
      + " exact_query_replay=" + $exact_probe.ok
      + " healthy_control_check=" + $control_probe.ok
      + " public_surface_split=" + (if graph_probe_captured($by_address_probe) and graph_probe_captured($list_probe) and graph_probe_captured($transactions_probe) then "captured" else "failed" end)
      + " direct_rpc_check=" + ($rpc_probe.status // "skipped")
    )
  }'
