#!/bin/sh
set -e

CONFIG_DIR="/home/node/.openclaw"
WORKSPACE_DIR="/home/node/workspace"
AGENTS_STATE_DIR="$CONFIG_DIR/agents"

echo "[entrypoint] === STARTUP DIAGNOSTICS ==="
echo "[entrypoint] env vars received:"
echo "[entrypoint]   TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:+<set, ${#TELEGRAM_BOT_TOKEN} chars>}"
echo "[entrypoint]   GOOGLE_CLOUD_PROJECT='$GOOGLE_CLOUD_PROJECT'"
echo "[entrypoint]   GOOGLE_CLOUD_LOCATION='$GOOGLE_CLOUD_LOCATION'"
echo "[entrypoint]   GOOGLE_APPLICATION_CREDENTIALS='$GOOGLE_APPLICATION_CREDENTIALS'"
echo "[entrypoint]   GOOGLE_CREDENTIALS_JSON_B64=${GOOGLE_CREDENTIALS_JSON_B64:+<set>}"
echo "[entrypoint]   USER_TIMEZONE='$USER_TIMEZONE'"
echo "[entrypoint]   USER_NAME='$USER_NAME'"
echo "[entrypoint]   OUTLOOK_CLIENT_ID=${OUTLOOK_CLIENT_ID:+<set, ${#OUTLOOK_CLIENT_ID} chars>}"
echo "[entrypoint]   OUTLOOK_CLIENT_SECRET=${OUTLOOK_CLIENT_SECRET:+<set, ${#OUTLOOK_CLIENT_SECRET} chars>}"
echo "[entrypoint]   OPENCLAW_GATEWAY_PORT='$OPENCLAW_GATEWAY_PORT'"
echo "[entrypoint]   OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:+<set, ${#OPENCLAW_GATEWAY_TOKEN} chars>}"
echo "[entrypoint]   COMPOSIO_API_KEY=${COMPOSIO_API_KEY:+<set, ${#COMPOSIO_API_KEY} chars>}"
echo "[entrypoint]   MICROSOFT_TEAMS_AUTH_CONFIG_ID='$MICROSOFT_TEAMS_AUTH_CONFIG_ID'"
echo "[entrypoint]   USER_ID='$USER_ID'"
echo "[entrypoint] === END STARTUP DIAGNOSTICS ==="

# Validate user-provided env vars
: "${OPENCLAW_GATEWAY_PORT:?OPENCLAW_GATEWAY_PORT is required}"
: "${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN is required}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${COMPOSIO_API_KEY:?COMPOSIO_API_KEY is required}"
: "${GOOGLE_CLOUD_PROJECT:?GOOGLE_CLOUD_PROJECT is required}"
: "${GOOGLE_CLOUD_LOCATION:?GOOGLE_CLOUD_LOCATION is required}"
: "${GOOGLE_APPLICATION_CREDENTIALS:?GOOGLE_APPLICATION_CREDENTIALS is required}"
: "${GOOGLE_CREDENTIALS_JSON_B64:?GOOGLE_CREDENTIALS_JSON_B64 is required}"
: "${USER_TIMEZONE:?USER_TIMEZONE is required}"
: "${USER_NAME:?USER_NAME is required}"
: "${OUTLOOK_CLIENT_ID:?OUTLOOK_CLIENT_ID is required}"
: "${OUTLOOK_CLIENT_SECRET:?OUTLOOK_CLIENT_SECRET is required}"
: "${MICROSOFT_TEAMS_AUTH_CONFIG_ID:?MICROSOFT_TEAMS_AUTH_CONFIG_ID is required}"
: "${USER_ID:?USER_ID is required}"

export TZ="$$USER_TIMEZONE"

# Write Google ADC credentials from base64 env var if provided.
# This is useful when containers are started on remote servers via SSH and
# mounting a local credential file is impractical.
if [ -n "$GOOGLE_CREDENTIALS_JSON_B64" ]; then
  echo "[entrypoint] Writing Google ADC credentials from GOOGLE_CREDENTIALS_JSON_B64"
  mkdir -p "$(dirname "$GOOGLE_APPLICATION_CREDENTIALS")"
  printf '%s' "$GOOGLE_CREDENTIALS_JSON_B64" | base64 -d > "$GOOGLE_APPLICATION_CREDENTIALS"
  chmod 600 "$GOOGLE_APPLICATION_CREDENTIALS"
fi

# Validate Vertex AI ADC credential file
if [ ! -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
  echo "[entrypoint] ERROR: GOOGLE_APPLICATION_CREDENTIALS file not found at: $GOOGLE_APPLICATION_CREDENTIALS" >&2
  exit 1
fi

# Seed Outlook credentials if provided via env
OUTLOOK_CONFIG="/home/node/.outlook-mcp/config.json"
if [ -n "$OUTLOOK_CLIENT_ID" ] && [ -n "$OUTLOOK_CLIENT_SECRET" ]; then
  if [ ! -f "$OUTLOOK_CONFIG" ]; then
    echo "[entrypoint] Seeding Outlook config from env vars"
    mkdir -p "/home/node/.outlook-mcp"
    printf '{\n  "client_id": "%s",\n  "client_secret": "%s",\n  "timezone": "%s"\n}\n' \
      "$OUTLOOK_CLIENT_ID" "$OUTLOOK_CLIENT_SECRET" "$USER_TIMEZONE" > "$OUTLOOK_CONFIG"
    chmod 600 "$OUTLOOK_CONFIG"
  fi
fi

# Generate per-user internal tokens on first run
TOKENS_FILE="$CONFIG_DIR/.tokens"
if [ ! -f "$TOKENS_FILE" ]; then
  echo "[entrypoint] Generating internal tokens"
  mkdir -p "$CONFIG_DIR"
  GATEWAY_AUTH_TOKEN=$(openssl rand -hex 24)
  HOOKS_TOKEN=$(openssl rand -hex 32)
  printf 'GATEWAY_AUTH_TOKEN=%s\nHOOKS_TOKEN=%s\n' "$GATEWAY_AUTH_TOKEN" "$HOOKS_TOKEN" > "$TOKENS_FILE"
  chmod 600 "$TOKENS_FILE"
fi
. "$TOKENS_FILE"
export GATEWAY_AUTH_TOKEN HOOKS_TOKEN

# Seed openclaw.json if missing
if [ ! -f "$CONFIG_DIR/openclaw.json" ]; then
  echo "[entrypoint] Generating openclaw.json"
  mkdir -p "$CONFIG_DIR"
  envsubst < /opt/templates/openclaw.template.json > "$CONFIG_DIR/openclaw.json.tmp"
  jq '.gateway.port |= tonumber' "$CONFIG_DIR/openclaw.json.tmp" > "$CONFIG_DIR/openclaw.json"
  rm -f "$CONFIG_DIR/openclaw.json.tmp"
  chmod 600 "$CONFIG_DIR/openclaw.json"
fi

# Seed per-agent auth-profiles.json files
for agent_id in main outlook-triage-agent; do
  AUTH_DIR="$AGENTS_STATE_DIR/$agent_id/agent"
  AUTH_FILE="$AUTH_DIR/auth-profiles.json"
  if [ ! -f "$AUTH_FILE" ]; then
    echo "[entrypoint] Writing auth-profiles.json for agent: $agent_id"
    mkdir -p "$AUTH_DIR"
    envsubst < /opt/templates/auth-profiles.template.json > "$AUTH_FILE"
    chmod 600 "$AUTH_FILE"
  fi
done

# Seed workspace if empty
if [ -z "$(ls -A "$WORKSPACE_DIR" 2>/dev/null)" ]; then
  echo "[entrypoint] Seeding workspace from /app/agent-workspace"
  mkdir -p "$WORKSPACE_DIR"
  cp -r /app/agent-workspace/. "$WORKSPACE_DIR/"

  echo "[entrypoint] === USER.MD SUBSTITUTION DIAGNOSTICS ==="
  echo "[entrypoint] Listing all subdirectories of $WORKSPACE_DIR:"
  ls -la "$WORKSPACE_DIR"

  for agent_dir in "$WORKSPACE_DIR"/*/; do
    echo "[entrypoint] checking agent dir: $agent_dir"
    echo "[entrypoint]   files inside:"
    ls -la "$agent_dir" | head -20

    if [ -f "${agent_dir}AGENTS.md" ]; then
      echo "[entrypoint]   ✓ AGENTS.md present — writing USER.md"
      envsubst < /opt/templates/USER.template.md > "${agent_dir}USER.md"
      echo "[entrypoint]   --- written USER.md content ---"
      cat "${agent_dir}USER.md"
      echo "[entrypoint]   --- end ---"
    else
      echo "[entrypoint]   ✗ AGENTS.md not found at ${agent_dir}AGENTS.md — skipping"
    fi
  done
  echo "[entrypoint] === END USER.MD SUBSTITUTION DIAGNOSTICS ==="
fi

# Start cron daemon if installed
if command -v cron >/dev/null 2>&1; then
  if pgrep -x cron >/dev/null 2>&1; then
    echo "[entrypoint] cron already running"
  else
    echo "[entrypoint] Starting cron daemon"
    cron || echo "[entrypoint] WARNING: cron failed to start"
  fi
else
  echo "[entrypoint] cron not installed; skipping cron daemon start"
fi

exec "$@"
