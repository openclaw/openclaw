#!/bin/bash
set -e

# Create config directory
mkdir -p ~/.openclaw

CONFIG_FILE=~/.openclaw/openclaw.json

# Create base config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
  echo '{}' > "$CONFIG_FILE"
fi

# Use openclaw config set to merge settings (preserves existing config like channels)
node /app/dist/index.js config set gateway.trustedProxies '["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"]'
node /app/dist/index.js config set gateway.bind lan
node /app/dist/index.js config set gateway.port 3000

# Execute the main command
exec "$@"
