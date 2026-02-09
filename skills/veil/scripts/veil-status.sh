#!/usr/bin/env bash
# Check Veil configuration and service status.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

veil_cli status "$@"
