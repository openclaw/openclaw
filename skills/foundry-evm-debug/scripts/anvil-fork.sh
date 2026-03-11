#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <chain-id> [fork-block-number]" >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chain_id="$1"
fork_block="${2:-}"
rpc_url="$("$script_dir/rpc-url.sh" "$chain_id")"

echo "warning: anvil exposes --fork-url in process arguments; treat local process listings as secret-bearing while this fork runs" >&2

args=(
  --fork-url "$rpc_url"
  --auto-impersonate
)

if [[ -n "$fork_block" ]]; then
  if [[ ! "$fork_block" =~ ^[0-9]+$ ]]; then
    echo "fork block must be numeric: $fork_block" >&2
    exit 64
  fi
  args+=(--fork-block-number "$fork_block")
fi

exec anvil "${args[@]}"
