#!/bin/bash
set -e

CONFIG_DIR=~/.openclaw
CONFIG_FILE=$CONFIG_DIR/openclaw.json
AUTH_FILE=$CONFIG_DIR/agents/main/agent/auth-profiles.json

# Create directories
mkdir -p $CONFIG_DIR/agents/main/agent

# Initialize config from template if not exists (for persistent volumes)
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Initializing config from template..."
  cp /app/.openclaw-template/openclaw.json $CONFIG_FILE
  cp /app/.openclaw-template/agents/main/agent/auth-profiles.json $AUTH_FILE
fi

# Replace placeholders with environment variables
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  sed -i "s|__TELEGRAM_BOT_TOKEN__|$TELEGRAM_BOT_TOKEN|g" $CONFIG_FILE
fi

if [ -n "$ANTHROPIC_API_KEY" ]; then
  sed -i "s|__ANTHROPIC_API_KEY__|$ANTHROPIC_API_KEY|g" $AUTH_FILE
fi

# Ensure gateway settings for Docker environment
node /app/dist/index.js config set gateway.trustedProxies '["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"]' 2>/dev/null || true
node /app/dist/index.js config set gateway.bind lan 2>/dev/null || true
node /app/dist/index.js config set gateway.port 3000 2>/dev/null || true

# Execute the main command
exec "$@"
