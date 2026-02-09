#!/usr/bin/env bash
# Private transfer within the pool to another registered address.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

AMOUNT="${1:?amount required}"
RECIPIENT="${2:?recipient address required}"

veil_cli transfer ETH "$AMOUNT" "$RECIPIENT" --quiet
