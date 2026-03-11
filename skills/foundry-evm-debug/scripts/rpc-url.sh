#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <chain-id>" >&2
  exit 64
fi

chain_id="$1"
if [[ ! "$chain_id" =~ ^[0-9]+$ ]]; then
  echo "chain id must be numeric: $chain_id" >&2
  exit 64
fi

rpc_secret="${RPC_SECRET:-}"
if [[ -z "$rpc_secret" ]]; then
  echo "RPC_SECRET is required" >&2
  exit 64
fi

rpc_base="${MORPHO_EVM_RPC_BASE:-https://rpc.morpho.dev/cache/evm}"
encoded_secret="$(
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' -- "$rpc_secret"
)"
printf '%s/%s?secret=%s\n' "${rpc_base%/}" "$chain_id" "$encoded_secret"
