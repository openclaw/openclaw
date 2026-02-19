#!/bin/sh
# Docker/Podman entrypoint script for OpenClaw gateway
# Creates minimal config on first run, then starts the gateway

set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
CONFIG_FILE="$STATE_DIR/openclaw.json"
TRUSTED_PROXY_HOST="${OPENCLAW_TRUSTED_PROXY_HOST:-}"
TRUSTED_PROXY_IP=""

resolve_trusted_proxy_ip() {
  host="$1"
  if [ -z "$host" ]; then
    return 0
  fi
  getent hosts "$host" 2>/dev/null | awk 'NR==1 {print $1}'
}

# Create state directory if it doesn't exist
mkdir -p "$STATE_DIR"

if [ -n "$TRUSTED_PROXY_HOST" ]; then
  TRUSTED_PROXY_IP="$(resolve_trusted_proxy_ip "$TRUSTED_PROXY_HOST")"
  if [ -n "$TRUSTED_PROXY_IP" ]; then
    echo "Resolved trusted proxy host $TRUSTED_PROXY_HOST -> $TRUSTED_PROXY_IP"
  else
    echo "Warning: could not resolve trusted proxy host $TRUSTED_PROXY_HOST"
  fi
fi

# Create minimal config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Creating initial config at $CONFIG_FILE"
  if [ -n "$TRUSTED_PROXY_IP" ]; then
    cat > "$CONFIG_FILE" << EOF
{
  "gateway": {
    "mode": "local",
    "trustedProxies": ["$TRUSTED_PROXY_IP"],
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "plugins": {
    "slots": {
      "memory": "none"
    }
  }
}
EOF
  else
    cat > "$CONFIG_FILE" << 'EOF'
{
  "gateway": {
    "mode": "local",
    "trustedProxies": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "plugins": {
    "slots": {
      "memory": "none"
    }
  }
}
EOF
  fi
  echo "Initial config created. Configure via:"
  echo "  - Web UI at your gateway URL"
  echo "  - Remote CLI: openclaw config set gateway.mode remote && openclaw config set gateway.remote.url wss://YOUR_DOMAIN/ws"
fi

if [ -n "$TRUSTED_PROXY_IP" ] && [ -f "$CONFIG_FILE" ]; then
  OPENCLAW_TRUSTED_PROXY_IP="$TRUSTED_PROXY_IP" OPENCLAW_CONFIG_FILE="$CONFIG_FILE" node << 'NODE'
const fs = require("fs");

const file = process.env.OPENCLAW_CONFIG_FILE;
const ip = process.env.OPENCLAW_TRUSTED_PROXY_IP;

if (!file || !ip) {
  process.exit(0);
}

let data = {};
try {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  data = {};
}

if (!data.gateway || typeof data.gateway !== "object") {
  data.gateway = {};
}

const existing = Array.isArray(data.gateway.trustedProxies) ? data.gateway.trustedProxies : [];
if (!existing.includes(ip)) {
  data.gateway.trustedProxies = [...existing, ip];
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
NODE
fi

# Run the gateway
exec node dist/index.js gateway --bind lan --port 18789 "$@"
