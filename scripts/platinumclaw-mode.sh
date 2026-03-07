#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible shim. Prefer scripts/platinumfang-mode.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/platinumfang-mode.sh" "$@"
