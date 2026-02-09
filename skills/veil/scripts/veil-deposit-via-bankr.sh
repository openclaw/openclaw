#!/usr/bin/env bash
# Build unsigned deposit tx JSON and submit via Bankr.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

AMOUNT="${1:?amount required}"
shift || true

TX_JSON=$(veil_cli deposit ETH "$AMOUNT" --unsigned --quiet "$@")

echo "$TX_JSON" | "$SCRIPT_DIR/veil-bankr-submit-tx.sh"
