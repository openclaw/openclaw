#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export RCA_PROVIDER_MODEL="${RCA_PROVIDER_MODEL:-anthropic/claude-opus-4-6}"
export RCA_PROVIDER_THINKING="${RCA_PROVIDER_THINKING:-high}"
export RCA_PROVIDER_SESSION_PREFIX="${RCA_PROVIDER_SESSION_PREFIX:-rca-claude}"

exec "${SCRIPT_DIR}/rca-provider-openclaw-agent.sh" "$@"
