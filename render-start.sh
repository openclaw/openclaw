#!/bin/sh
# Render start script - binds to all interfaces for external access

# Create config file with Control UI fallback enabled and gateway token
mkdir -p "${OPENCLAW_STATE_DIR:-/tmp/.openclaw}"
cat > "${OPENCLAW_STATE_DIR:-/tmp/.openclaw}/openclaw.json" << EOF
{
  "gateway": {
    "bind": "lan",
    "port": 10000,
    "token": "${OPENCLAW_GATEWAY_TOKEN}",
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true
    }
  }
}
EOF

exec node openclaw.mjs gateway --bind lan --port "${PORT:-10000}" --allow-unconfigured
