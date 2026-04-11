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
  # Use jq if available, otherwise use node for safe JSON manipulation
  if command -v jq >/dev/null 2>&1; then
    jq --arg token "$OPENCLAW_GATEWAY_TOKEN" '.gateway.token = $token' \
      "${OPENCLAW_STATE_DIR:-/tmp/.openclaw}/openclaw.json" > /tmp/openclaw.json.tmp && \
      mv /tmp/openclaw.json.tmp "${OPENCLAW_STATE_DIR:-/tmp/.openclaw}/openclaw.json"
  else
    # Fallback: use node to safely add token to JSON
    node -e "
      const fs = require('fs');
      const path = '${OPENCLAW_STATE_DIR:-/tmp/.openclaw}/openclaw.json';
      const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
      cfg.gateway.token = process.env.OPENCLAW_GATEWAY_TOKEN;
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
    "
  fi
fi

exec node openclaw.mjs gateway --bind lan --port "${PORT:-10000}" --allow-unconfigured
