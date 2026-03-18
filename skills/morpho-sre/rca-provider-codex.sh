#!/usr/bin/env bash
set -euo pipefail

# RCA provider: Codex via openclaw agent (fallback provider).
# openclaw agent picks up OPENAI_API_KEY from the environment automatically
# when using openai-codex/* models.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export RCA_PROVIDER_MODEL="${RCA_PROVIDER_MODEL:-openai-codex/gpt-5.4}"
export RCA_PROVIDER_SESSION_PREFIX="${RCA_PROVIDER_SESSION_PREFIX:-rca-codex}"

exec "${SCRIPT_DIR}/rca-provider-openclaw-agent.sh" "$@"
