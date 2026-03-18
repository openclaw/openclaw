#!/usr/bin/env bash
set -euo pipefail

# RCA provider: Codex via openclaw agent with API key auth (primary provider).
# openclaw agent picks up OPENAI_API_KEY from the environment automatically
# when using openai-codex/* models. No OAuth needed.
#
# If codex fails (rate limit, timeout, auth), falls back to claude provider.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

prompt="${1:-}"
timeout_ms="${2:-${RCA_LLM_TIMEOUT_MS:-15000}}"

export RCA_PROVIDER_MODEL="${RCA_PROVIDER_MODEL:-openai-codex/gpt-5.4}"
export RCA_PROVIDER_SESSION_PREFIX="${RCA_PROVIDER_SESSION_PREFIX:-rca-codex}"

if "${SCRIPT_DIR}/rca-provider-openclaw-agent.sh" "$@"; then
  exit 0
fi

# Codex failed — fall back to claude
printf 'codex unavailable, falling back to claude provider\n' >&2
exec "${SCRIPT_DIR}/rca-provider-claude.sh" "$@"
