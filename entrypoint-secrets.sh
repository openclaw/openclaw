#!/usr/bin/env sh
set -eu

require_secret() {
  env_name="$1"
  path_name="$2"
  path_value="$(eval "printf '%s' \"\${$path_name:-}\"")"
  if [ -z "$path_value" ]; then
    echo "missing required env var: $path_name" >&2
    exit 1
  fi
  if [ ! -r "$path_value" ]; then
    echo "secret file not readable: $path_name" >&2
    exit 1
  fi
  secret_value="$(cat "$path_value")"
  if [ -z "$secret_value" ]; then
    echo "secret file empty: $path_name" >&2
    exit 1
  fi
  export "$env_name=$secret_value"
  unset secret_value
}

# OPENAI_API_KEY is intentionally disabled here (OAuth auth/profile mode).
# If you later switch to API key auth, add:
#   require_secret OPENAI_API_KEY OPENAI_API_KEY_PATH
require_secret DISCORD_BOT_TOKEN DISCORD_BOT_TOKEN_PATH
require_secret DISCORD_APPLICATION_ID DISCORD_APPLICATION_ID_PATH
require_secret OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_TOKEN_PATH
require_secret GOG_KEYRING_PASSWORD GOG_KEYRING_PASSWORD_PATH
require_secret PERPLEXITY_API_KEY PERPLEXITY_API_KEY_PATH
require_secret GEMINI_API_KEY GEMINI_API_KEY_PATH
require_secret NOTION_API_KEY NOTION_API_KEY_PATH

# Backward-compat aliases for older local scripts/workflows.
if [ -z "${NOTION_KEY:-}" ]; then
  export NOTION_KEY="$NOTION_API_KEY"
fi
if [ -z "${NOTION_TOKEN:-}" ]; then
  export NOTION_TOKEN="$NOTION_API_KEY"
fi

exec "$@"
