#!/usr/bin/env bash
set -euo pipefail

# Apply the lean Telegram /model catalog preset to the active OpenClaw config.
# This keeps the active default at Codex 5.3 and limits picker choices to the
# agreed allowlist.

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw CLI not found in PATH." >&2
  exit 1
fi

read -r -d '' MODELS_JSON <<'JSON' || true
{
  "anthropic/claude-opus-4-6": { "alias": "Opus" },
  "anthropic/claude-sonnet-4-6": { "alias": "Sonnet" },
  "anthropic/claude-haiku-4-5": { "alias": "Haiku" },
  "openai/gpt-5.4": { "alias": "GPT 5.4" },
  "openai-codex/gpt-5.4": { "alias": "Codex 5.4" },
  "openai-codex/gpt-5.3-codex": { "alias": "Codex 5.3" },
  "openai-codex/gpt-5.3-codex-spark": { "alias": "Codex Spark" },
  "openai-codex/gpt-5.1-codex-mini": { "alias": "Codex Mini" },
  "minimax/MiniMax-M2.5": { "alias": "MiniMax" },
  "moonshot/kimi-k2.5": { "alias": "Moonshot Kimi" },
  "kimi-coding/k2p5": { "alias": "Kimi Coding" },
  "google/gemini-3.1-pro-preview": { "alias": "Gemini 3.1 Pro" },
  "google/gemini-3-flash-preview": { "alias": "Gemini 3 Flash" }
}
JSON

echo "Setting default model to openai-codex/gpt-5.3-codex..."
openclaw config set agents.defaults.model.primary openai-codex/gpt-5.3-codex

echo "Applying lean allowlist to agents.defaults.models..."
openclaw config set agents.defaults.models "${MODELS_JSON}" --strict-json

echo "Done. Restart gateway/bot process to apply."
