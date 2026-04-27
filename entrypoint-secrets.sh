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

optional_secret() {
  env_name="$1"
  path_name="$2"
  path_value="$(eval "printf '%s' \"\${$path_name:-}\"")"
  if [ -z "$path_value" ] || [ ! -r "$path_value" ]; then
    return 0
  fi
  secret_value="$(cat "$path_value")"
  if [ -z "$secret_value" ]; then
    unset secret_value
    return 0
  fi
  export "$env_name=$secret_value"
  unset secret_value
}

# OPENAI_API_KEY is intentionally disabled here (OAuth auth/profile mode).
# If you later switch to API key auth, add:
#   require_secret OPENAI_API_KEY OPENAI_API_KEY_PATH
export PATH="/home/node/.openclaw/bin:${PATH}"
require_secret DISCORD_BOT_TOKEN DISCORD_BOT_TOKEN_PATH
require_secret DISCORD_APPLICATION_ID DISCORD_APPLICATION_ID_PATH
require_secret OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_TOKEN_PATH
require_secret GOG_KEYRING_PASSWORD GOG_KEYRING_PASSWORD_PATH
require_secret PERPLEXITY_API_KEY PERPLEXITY_API_KEY_PATH
require_secret GEMINI_API_KEY GEMINI_API_KEY_PATH
require_secret NOTION_API_KEY NOTION_API_KEY_PATH
optional_secret DUNE_API_KEY DUNE_API_KEY_PATH
require_secret OPENCLAW_GITHUB_APP_ID OPENCLAW_GITHUB_APP_ID_PATH
require_secret OPENCLAW_GITHUB_APP_INSTALLATION_ID OPENCLAW_GITHUB_APP_INSTALLATION_ID_PATH
if [ -z "${OPENCLAW_GITHUB_APP_PRIVATE_KEY_PATH:-}" ] || [ ! -r "$OPENCLAW_GITHUB_APP_PRIVATE_KEY_PATH" ]; then
  echo "secret file not readable: OPENCLAW_GITHUB_APP_PRIVATE_KEY_PATH" >&2
  exit 1
fi
export OPENCLAW_GH_READ_APP_ID="$OPENCLAW_GITHUB_APP_ID"
export OPENCLAW_GH_READ_INSTALLATION_ID="$OPENCLAW_GITHUB_APP_INSTALLATION_ID"
export OPENCLAW_GH_READ_PRIVATE_KEY_FILE="$OPENCLAW_GITHUB_APP_PRIVATE_KEY_PATH"
export OPENCLAW_GH_APP_SECRETS_DIR="${OPENCLAW_GH_APP_SECRETS_DIR:-/run/secrets}"
export GITHUB_TOKEN_FILE="${GITHUB_TOKEN_FILE:-/tmp/openclaw-gh-token}"
require_secret GOOGLE_MAPS_API_KEY GOOGLE_MAPS_API_KEY_PATH
require_secret LINEAR_API_KEY LINEAR_API_KEY_PATH
require_secret LINEAR_WEBHOOK_SECRET LINEAR_WEBHOOK_SECRET_PATH
require_secret LINEAR_ALLOWED_TEAM_IDS LINEAR_ALLOWED_TEAM_IDS_PATH
require_secret GRANOLA_API_KEY GRANOLA_API_KEY_PATH

# Backward-compat aliases for older local scripts/workflows.
if [ -z "${NOTION_KEY:-}" ]; then
  export NOTION_KEY="$NOTION_API_KEY"
fi
if [ -z "${NOTION_TOKEN:-}" ]; then
  export NOTION_TOKEN="$NOTION_API_KEY"
fi

# Install GitHub deploy key if provided via Docker secret
if [ -f /run/secrets/github_deploy_key ]; then
  mkdir -p /home/node/.ssh
  install -m 600 /run/secrets/github_deploy_key /home/node/.ssh/id_ed25519
  install -m 644 /run/secrets/github_known_hosts /home/node/.ssh/known_hosts 2>/dev/null || true
fi

if ! /usr/local/bin/openclaw-gh-token --probe > "${GITHUB_TOKEN_FILE}.tmp" 2>"${GITHUB_TOKEN_FILE}.err"; then
  echo "[entrypoint-secrets] FATAL: github app token probe failed" >&2
  sed 's/^/[github-app] /' < "${GITHUB_TOKEN_FILE}.err" >&2
  rm -f "${GITHUB_TOKEN_FILE}.tmp" "${GITHUB_TOKEN_FILE}.err"
  exit 1
fi
mv "${GITHUB_TOKEN_FILE}.tmp" "$GITHUB_TOKEN_FILE"
chmod 0600 "$GITHUB_TOKEN_FILE"
rm -f "${GITHUB_TOKEN_FILE}.err"

(
  while sleep 3000; do
    if /usr/local/bin/openclaw-gh-token > "${GITHUB_TOKEN_FILE}.tmp" 2>/dev/null; then
      mv "${GITHUB_TOKEN_FILE}.tmp" "$GITHUB_TOKEN_FILE"
      chmod 0600 "$GITHUB_TOKEN_FILE"
    else
      rm -f "${GITHUB_TOKEN_FILE}.tmp"
      echo "[entrypoint-secrets] WARNING: github app token refresh failed; previous token still in place" >&2
    fi
  done
) &

# Run pipeline preflight when pipeline deps are baked into the image.
# Non-fatal for the gateway — a warning is logged but the gateway continues.
if [ -x "/usr/local/bin/preflight-pipeline.sh" ] && [ -d "${OCPIPELINE_VENV:-/opt/ocpipeline}" ]; then
  /usr/local/bin/preflight-pipeline.sh \
    || echo "[entrypoint-secrets] WARNING: pipeline preflight failed (non-fatal for gateway)" >&2
fi

# Obsidian sync runs on the host via systemd (obsidian-sync.service), not inside this container.
# The vault is shared via the /home/node/obsidian volume mount.

exec "$@"
