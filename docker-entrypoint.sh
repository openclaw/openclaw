#!/bin/bash
set -e

# Create config directory
mkdir -p ~/.openclaw

CONFIG_FILE=~/.openclaw/openclaw.json

# Create base config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
  echo '{}' > "$CONFIG_FILE"
fi

# Only set gateway defaults if not already configured (preserves user settings on redeploy)
if ! node /app/dist/index.js config get gateway.bind 2>/dev/null | grep -q "lan\|loopback"; then
  node /app/dist/index.js config set gateway.bind lan
fi

if ! node /app/dist/index.js config get gateway.port 2>/dev/null | grep -q "[0-9]"; then
  node /app/dist/index.js config set gateway.port 3000
fi

# Always ensure trustedProxies are set for Docker networking
node /app/dist/index.js config set gateway.trustedProxies '["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"]'

# Execute the main command
exec "$@"
