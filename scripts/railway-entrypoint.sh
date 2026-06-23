#!/bin/sh
# Railway entrypoint for the OpenClaw gateway.
#
# 1) Writes the PaaS gateway config: Control UI host-header fallback + device-auth
#    off (needed behind Railway's proxy) AND enables the bundled admin-http-rpc
#    plugin so the Hypertransient MCP server can reach the gateway control plane
#    at POST /api/v1/admin/rpc.
# 2) Railway mounts the persistent volume ROOT-owned at /home/node/.openclaw, but
#    the gateway runs as `node`; chown it, then drop to node with HOME and
#    OPENCLAW_STATE_DIR pinned to the volume (so state lands there, not /root).
set -e

NODE_HOME="/home/node"
STATE_DIR="${OPENCLAW_STATE_DIR:-$NODE_HOME/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/app/.openclaw/openclaw.json}"
GATEWAY="node --max-old-space-size=4096 openclaw.mjs gateway --bind lan --port ${PORT:-18789} --allow-unconfigured"

write_config() {
  mkdir -p "$(dirname "$CONFIG_PATH")" 2>/dev/null || true
  cat > "$CONFIG_PATH" <<'JSON'
{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}},"plugins":{"entries":{"admin-http-rpc":{"enabled":true}}}}
JSON
}

mkdir -p "$STATE_DIR/workspace" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  write_config
  chown -R node:node "$STATE_DIR" 2>/dev/null || true
  chown node:node "$NODE_HOME" 2>/dev/null || true
  chown node:node "$CONFIG_PATH" 2>/dev/null || true
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid node --regid node --init-groups \
      env HOME="$NODE_HOME" OPENCLAW_STATE_DIR="$STATE_DIR" sh -c "$GATEWAY"
  elif command -v gosu >/dev/null 2>&1; then
    exec gosu node env HOME="$NODE_HOME" OPENCLAW_STATE_DIR="$STATE_DIR" sh -c "$GATEWAY"
  else
    exec su -s /bin/sh node -c "HOME=$NODE_HOME OPENCLAW_STATE_DIR=$STATE_DIR $GATEWAY"
  fi
else
  write_config 2>/dev/null || true
  export HOME="$NODE_HOME"
  export OPENCLAW_STATE_DIR="$STATE_DIR"
  exec sh -c "$GATEWAY"
fi
