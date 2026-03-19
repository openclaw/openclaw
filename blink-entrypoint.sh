#!/bin/bash
# Blink Claw entrypoint — runs as root, prepares /data, drops to node user.
# Handles fresh Fly volumes (root-owned /data) gracefully.

# Create state dirs on fresh volumes
mkdir -p /data/workspace /data/agents/main/agent /data/agents/main/sessions \
         /data/scripts /data/npm-global 2>/dev/null

# Minimal openclaw.json so the gateway can start before provision-boot writes the real one
if [ ! -f /data/openclaw.json ]; then
  cat > /data/openclaw.json <<'CONF'
{"agents":{"defaults":{"workspace":"/data/workspace"}},"gateway":{"auth":{"mode":"token"}}}
CONF
fi

# Ensure node user owns everything
chown -R node:node /data 2>/dev/null || true

# Source agent secrets
[ -f /data/.env ] && set -a && . /data/.env && set +a

# Drop to node user and exec the command (CMD or init.cmd)
exec gosu node "$@"
