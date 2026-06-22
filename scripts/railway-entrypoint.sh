#!/bin/sh
# Railway entrypoint for the OpenClaw gateway.
#
# Railway mounts the persistent volume ROOT-OWNED at /home/node/.openclaw, but
# the gateway runs as the unprivileged `node` user. Start as root, fix ownership
# of the mounted state dir, then drop to `node` — pinning HOME and
# OPENCLAW_STATE_DIR so the gateway uses the (now node-owned) volume instead of
# /root/.openclaw (setpriv/gosu do NOT reset HOME on their own).
set -e

NODE_HOME="/home/node"
STATE_DIR="${OPENCLAW_STATE_DIR:-$NODE_HOME/.openclaw}"
GATEWAY="node --max-old-space-size=4096 openclaw.mjs gateway --bind lan --port ${PORT:-18789} --allow-unconfigured"

mkdir -p "$STATE_DIR/workspace" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$STATE_DIR" 2>/dev/null || true
  chown node:node "$NODE_HOME" 2>/dev/null || true
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid node --regid node --init-groups \
      env HOME="$NODE_HOME" OPENCLAW_STATE_DIR="$STATE_DIR" sh -c "$GATEWAY"
  elif command -v gosu >/dev/null 2>&1; then
    exec gosu node env HOME="$NODE_HOME" OPENCLAW_STATE_DIR="$STATE_DIR" sh -c "$GATEWAY"
  else
    exec su -s /bin/sh node -c "HOME=$NODE_HOME OPENCLAW_STATE_DIR=$STATE_DIR $GATEWAY"
  fi
else
  export HOME="$NODE_HOME"
  export OPENCLAW_STATE_DIR="$STATE_DIR"
  exec sh -c "$GATEWAY"
fi
