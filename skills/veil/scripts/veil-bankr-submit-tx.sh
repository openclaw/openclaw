#!/usr/bin/env bash
# Submit an unsigned EVM tx JSON to Bankr for signing+submission.
# Input: JSON on stdin or a file path as $1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

need_bankr_config

if [[ $# -gt 0 ]]; then
  TX_JSON=$(cat "$1")
else
  TX_JSON=$(cat)
fi

# Validate required fields exist
if ! echo "$TX_JSON" | jq -e '.to and .data and .value and .chainId' >/dev/null 2>&1; then
  echo "Invalid transaction JSON. Required fields: to, data, value, chainId" >&2
  echo "Received: $TX_JSON" >&2
  exit 1
fi

PROMPT=$'Submit this transaction (do not change any fields):\n'
PROMPT+="$TX_JSON"

"$SCRIPT_DIR/veil-bankr-prompt.sh" "$PROMPT"
