#!/usr/bin/env bash
# Merge/consolidate UTXOs by self-transfer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

AMOUNT="${1:?amount required}"

veil_cli merge ETH "$AMOUNT" --quiet
