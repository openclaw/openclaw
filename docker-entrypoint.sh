#!/usr/bin/env bash
# docker-entrypoint.sh
#
# Load Docker secrets from /run/secrets/ into environment variables.
# Falls back to direct environment variables for backward compatibility.
#
# Secret file naming convention:
#   /run/secrets/openclaw_gateway_token -> OPENCLAW_GATEWAY_TOKEN
#   /run/secrets/claude_ai_session_key -> CLAUDE_AI_SESSION_KEY
#
# Only exports a variable if it is not already set in the environment,
# so direct env vars always take precedence.

load_secret() {
  local env_name="$1"
  local secret_file="$2"

  # Skip if the variable is already set
  if printenv "$env_name" >/dev/null 2>&1; then
    return
  fi

  if [ -f "$secret_file" ] && [ -r "$secret_file" ]; then
    if ! export "$env_name"="$(cat "$secret_file")"; then
      echo "Warning: Failed to load secret from $secret_file" >&2
    fi
  fi
}

# Map Docker secrets to environment variables
load_secret "OPENCLAW_GATEWAY_TOKEN" "/run/secrets/openclaw_gateway_token"
load_secret "OPENCLAW_GATEWAY_PASSWORD" "/run/secrets/openclaw_gateway_password"
load_secret "CLAUDE_AI_SESSION_KEY" "/run/secrets/claude_ai_session_key"
load_secret "CLAUDE_WEB_SESSION_KEY" "/run/secrets/claude_web_session_key"
load_secret "CLAUDE_WEB_COOKIE" "/run/secrets/claude_web_cookie"
load_secret "OPENAI_API_KEY" "/run/secrets/openai_api_key"
load_secret "ANTHROPIC_API_KEY" "/run/secrets/anthropic_api_key"
load_secret "GEMINI_API_KEY" "/run/secrets/gemini_api_key"

# Execute the original command
exec "$@"
