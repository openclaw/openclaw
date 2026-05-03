#!/bin/sh
set -e

CONFIG_DIR="/home/node/.openclaw"
WORKSPACE_DIR="/home/node/workspace"
AGENTS_STATE_DIR="$CONFIG_DIR/agents"

echo "[entrypoint] === STARTUP DIAGNOSTICS ==="
echo "[entrypoint] env vars received:"
echo "[entrypoint]   TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:+<set, ${#TELEGRAM_BOT_TOKEN} chars>}"
echo "[entrypoint]   LLM_API_KEY=${LLM_API_KEY:+<set, ${#LLM_API_KEY} chars>}"
echo "[entrypoint]   USER_TIMEZONE='$USER_TIMEZONE'"
echo "[entrypoint]   USER_NAME='$USER_NAME'"
echo "[entrypoint] === END STARTUP DIAGNOSTICS ==="

# Validate user-provided env vars
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${LLM_API_KEY:?LLM_API_KEY is required}"
: "${USER_TIMEZONE:?USER_TIMEZONE is required}"
: "${USER_NAME:?USER_NAME is required}"

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
  envsubst < /opt/templates/openclaw.template.json > "$CONFIG_DIR/openclaw.json"
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

  # ────── USER.md substitution loop with diagnostics ──────
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
  # ────── end substitution loop ──────
fi

exec "$@"