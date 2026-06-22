#!/bin/sh
# Railway entrypoint for the OpenClaw gateway.
#
# Railway mounts persistent volumes ROOT-OWNED, but the gateway runs as the
# unprivileged `node` user — so without this it cannot create its workspace under
# the mounted state dir (EACCES on /home/node/.openclaw/workspace) and
# heartbeats / memory / sessions silently fail. We start as root, fix ownership
# of the mounted state dir, then drop to `node` and exec the gateway.
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
GATEWAY="node --max-old-space-size=4096 openclaw.mjs gateway --bind lan --port ${PORT:-18789} --allow-unconfigured"

mkdir -p "$STATE_DIR/workspace" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  # Running as root: fix the root-owned volume, then drop to node.
  chown -R node:node "$STATE_DIR" 2>/dev/null || true
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid node --regid node --init-groups sh -c "$GATEWAY"
  elif command -v gosu >/dev/null 2>&1; then
    exec gosu node sh -c "$GATEWAY"
  else
    exec su -s /bin/sh node -c "$GATEWAY"
  fi
else
  # Already unprivileged (e.g. local run): just start.
  exec sh -c "$GATEWAY"
fi
