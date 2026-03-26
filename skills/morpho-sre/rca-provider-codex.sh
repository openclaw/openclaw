#!/usr/bin/env bash
set -euo pipefail

# RCA provider: direct OpenAI via openclaw agent.
# File name kept for compatibility with existing wrappers and hooks.
# openclaw agent picks up OPENAI_API_KEY from the environment automatically
# when using openai/* models.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export RCA_PROVIDER_MODEL="${RCA_PROVIDER_MODEL:-openai/gpt-5.4}"
export RCA_PROVIDER_SESSION_PREFIX="${RCA_PROVIDER_SESSION_PREFIX:-rca-openai}"

exec "${SCRIPT_DIR}/rca-provider-openclaw-agent.sh" "$@"
