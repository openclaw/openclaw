#!/bin/sh
# Render start script - binds to all interfaces for external access

# Create config file with Control UI fallback enabled
mkdir -p "${OPENCLAW_STATE_DIR:-/tmp/.openclaw}"
cat > "${OPENCLAW_STATE_DIR:-/tmp/.openclaw}/openclaw.json" << 'EOF'
{
  "gateway": {
    "bind": "lan",
    "port": 10000,
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true
    }
  }
}
EOF

# Inject token separately to avoid shell expansion issues in JSON
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
  TOKEN_ESCAPED=$(echo "$OPENCLAW_GATEWAY_TOKEN" | sed 's/"/\\"/g')
  sed -i "s/\"port\": 10000,/\"port\": 10000,\n    \"token\": \"$TOKEN_ESCAPED\",/" "${OPENCLAW_STATE_DIR:-/tmp/.openclaw}/openclaw.json"
fi

exec node openclaw.mjs gateway --bind lan --port "${PORT:-10000}" --allow-unconfigured
