#!/usr/bin/env bash
# Build a Bankr-compatible unsigned deposit tx JSON (no signing).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

AMOUNT="${1:?amount required}"
shift || true

# Typical use: pass --deposit-key ... (or rely on env) and optionally --rpc-url
veil_cli deposit ETH "$AMOUNT" --unsigned --quiet "$@"
