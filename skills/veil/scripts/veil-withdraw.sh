#!/usr/bin/env bash
# Withdraw from private pool to a public address (executes locally using VEIL_KEY).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

AMOUNT="${1:?amount required}"
RECIPIENT="${2:?recipient address required}"

veil_cli withdraw ETH "$AMOUNT" "$RECIPIENT" --quiet
