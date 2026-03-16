#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Backward-compatible preflight alias.
exec "${SCRIPT_DIR}/telegram-live-runtime.sh" ensure "$@"
