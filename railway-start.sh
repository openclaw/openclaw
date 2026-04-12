#!/bin/sh
# Railway start script - binds to all interfaces for external access

# Create config file with Control UI security bypasses for Railway proxy
mkdir -p "${OPENCLAW_STATE_DIR:-/data/.openclaw}"
cat > "${OPENCLAW_STATE_DIR:-/data/.openclaw}/openclaw.json" << 'EOF'
{
  "gateway": {
    "bind": "lan",
    "port": 8080,
    "controlUi": {
      "basePath": "/openclaw",
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
EOF

# Inject token separately to avoid shell expansion issues in JSON
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
  # Use node to safely add token to JSON (under gateway.auth.token)
  node -e "
    const fs = require('fs');
    const path = '${OPENCLAW_STATE_DIR:-/data/.openclaw}/openclaw.json';
    const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!cfg.gateway.auth) cfg.gateway.auth = {};
    cfg.gateway.auth.mode = 'token';
    cfg.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
  "
fi

exec node openclaw.mjs gateway --bind lan --port "${PORT:-8080}" --allow-unconfigured
