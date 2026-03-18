#!/usr/bin/env bash
set -euo pipefail

# RCA provider: Codex via openclaw agent with API key auth (primary provider).
# openclaw agent picks up OPENAI_API_KEY from the environment automatically
# when using openai-codex/* models. No OAuth needed.
#
# Falls back to claude provider on any failure (rate limit, timeout, auth,
# empty response). Unsets codex env vars before calling claude to avoid
# model/session leakage.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Set codex model for the primary attempt only (not exported globally)
if RCA_PROVIDER_MODEL="${RCA_PROVIDER_MODEL:-openai-codex/gpt-5.4}" \
   RCA_PROVIDER_SESSION_PREFIX="${RCA_PROVIDER_SESSION_PREFIX:-rca-codex}" \
   "${SCRIPT_DIR}/rca-provider-openclaw-agent.sh" "$@"; then
  exit 0
fi

# Codex failed — fall back to claude (caller env preserved for claude config)
printf 'codex unavailable, falling back to claude provider\n' >&2
exec "${SCRIPT_DIR}/rca-provider-claude.sh" "$@"
