#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <chain-id> <tx-hash>" >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chain_id="$1"
tx_hash="$2"

if [[ ! "$tx_hash" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "invalid tx hash: $tx_hash" >&2
  exit 64
fi

ETH_RPC_URL="$("$script_dir/rpc-url.sh" "$chain_id")" exec cast run "$tx_hash"
