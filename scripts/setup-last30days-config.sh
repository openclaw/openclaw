#!/usr/bin/env bash
# Create/update ~/.config/last30days/.env from environment variables.
# Usage:
#   export OPENAI_API_KEY=sk-...
#   ./scripts/setup-last30days-config.sh
# Or run with no env: creates .env from .env.example so you can edit manually.

set -e

CONFIG_DIR="${HOME}/.config/last30days"
ENV_FILE="${CONFIG_DIR}/.env"
EXAMPLE="${CONFIG_DIR}/.env.example"

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# If .env exists and we have nothing to write, leave it as-is
if [[ -f "$ENV_FILE" && -z "${OPENAI_API_KEY:-}" && -z "${XAI_API_KEY:-}" ]]; then
  echo "Config already exists: $ENV_FILE (no env vars to merge)"
  exit 0
fi

# Create or update .env
if [[ -n "${OPENAI_API_KEY:-}" || -n "${XAI_API_KEY:-}" ]]; then
  : > "$ENV_FILE"
  [[ -n "${OPENAI_API_KEY:-}" ]] && echo "OPENAI_API_KEY=${OPENAI_API_KEY}" >> "$ENV_FILE"
  [[ -n "${XAI_API_KEY:-}" ]]  && echo "XAI_API_KEY=${XAI_API_KEY}" >> "$ENV_FILE"
  [[ -n "${PARALLEL_API_KEY:-}" ]]   && echo "PARALLEL_API_KEY=${PARALLEL_API_KEY}" >> "$ENV_FILE"
  [[ -n "${BRAVE_API_KEY:-}" ]]      && echo "BRAVE_API_KEY=${BRAVE_API_KEY}" >> "$ENV_FILE"
  [[ -n "${OPENROUTER_API_KEY:-}" ]] && echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE from environment"
else
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$EXAMPLE" ]]; then
      cp "$EXAMPLE" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      echo "Created $ENV_FILE from .env.example – edit and add your API keys"
    else
      echo "# last30days – add API keys here" > "$ENV_FILE"
      echo "OPENAI_API_KEY=" >> "$ENV_FILE"
      echo "XAI_API_KEY=" >> "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      echo "Created $ENV_FILE – add OPENAI_API_KEY (required) and optionally XAI_API_KEY"
    fi
  fi
fi
