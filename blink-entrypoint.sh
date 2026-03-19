#!/bin/bash
# Blink Claw entrypoint — runs as root, prepares /data, drops to node user.
# Handles fresh Fly volumes (root-owned /data) gracefully.

# Only run setup if /data is not yet owned by node (fresh volume)
if [ "$(stat -c %U /data 2>/dev/null)" != "node" ]; then
  mkdir -p /data/workspace /data/agents/main/agent /data/agents/main/sessions \
           /data/scripts /data/npm-global
  [ ! -f /data/openclaw.json ] && \
    echo '{"agents":{"defaults":{"workspace":"/data/workspace"}},"gateway":{"auth":{"mode":"token"}}}' > /data/openclaw.json
  chown -R node:node /data
fi

# Source agent secrets
[ -f /data/.env ] && set -a && . /data/.env && set +a

# Drop to node user and exec the command (CMD or init.cmd)
exec gosu node "$@"
