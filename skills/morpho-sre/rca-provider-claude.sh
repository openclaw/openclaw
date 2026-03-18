#!/usr/bin/env bash
set -euo pipefail

# RCA provider: Claude via openclaw agent (primary provider).
# Falls back to codex provider on any failure.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if RCA_PROVIDER_MODEL="${RCA_PROVIDER_MODEL:-anthropic/claude-opus-4-6}" \
   RCA_PROVIDER_THINKING="${RCA_PROVIDER_THINKING:-high}" \
   RCA_PROVIDER_SESSION_PREFIX="${RCA_PROVIDER_SESSION_PREFIX:-rca-claude}" \
   "${SCRIPT_DIR}/rca-provider-openclaw-agent.sh" "$@"; then
  exit 0
fi

# Claude failed — fall back to codex
printf 'claude unavailable, falling back to codex provider\n' >&2
exec "${SCRIPT_DIR}/rca-provider-codex.sh" "$@"
