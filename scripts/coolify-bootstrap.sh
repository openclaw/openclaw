#!/usr/bin/env bash
set -e

# OpenClaw Coolify Bootstrap Script
# Handles token management, config creation, and startup
#
# Environment Variables (from docker-compose.yaml):
#   - OPENCLAW_GATEWAY_TOKEN: Auth token (from SERVICE_PASSWORD_GATEWAY)
#   - OPENCLAW_GATEWAY_PORT: Internal port (default: 3000)
#   - ZAI_API_KEY: Model API key
#   - OPENCLAW_DOMAIN: Your custom domain (e.g., openclaw.coolify.example.com)

OPENCLAW_STATE="/root/.openclaw"
CONFIG_FILE="$OPENCLAW_STATE/openclaw.json"
WORKSPACE_DIR="/root/openclaw-workspace"
TOKEN_FILE="$OPENCLAW_STATE/.gateway_token"

# Default port for Coolify (Traefik routes to this)
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-3000}"
export OPENCLAW_GATEWAY_PORT

# Validate bind value
case "${OPENCLAW_GATEWAY_BIND:-}" in
  loopback|lan|tailnet|auto|custom)
    ;;
  *)
    export OPENCLAW_GATEWAY_BIND="lan"
    ;;
esac

# Create directories
mkdir -p "$OPENCLAW_STATE" "$WORKSPACE_DIR"
chmod 700 "$OPENCLAW_STATE"

# ----------------------------
# CLI Setup
# ----------------------------
mkdir -p /root/bin

# Create openclaw symlink
if [ ! -f /root/bin/openclaw ]; then
  ln -sf /app/openclaw.mjs /root/bin/openclaw
fi

# Ensure PATH is set
export PATH="/root/bin:$PATH"
if ! grep -q '/root/bin' /root/.bashrc 2>/dev/null; then
  echo 'export PATH="/root/bin:$PATH"' >> /root/.bashrc
fi

# Create openclaw-approve helper
if [ ! -f /root/bin/openclaw-approve ]; then
  cat > /root/bin/openclaw-approve <<'HELPER'
#!/bin/bash
echo "Approving all pending device requests..."
openclaw devices list --json 2>/dev/null | node -e "
const data = require('fs').readFileSync(0, 'utf8');
const devices = JSON.parse(data || '[]');
const pending = devices.filter(d => d.status === 'pending');
if (pending.length === 0) {
  console.log('No pending requests.');
  process.exit(0);
}
pending.forEach(d => {
  console.log('Approving:', d.id);
  require('child_process').execSync('openclaw devices approve ' + d.id);
});
console.log('Approved', pending.length, 'device(s)');
" 2>/dev/null || echo "No pending devices or command failed"
HELPER
  chmod +x /root/bin/openclaw-approve
fi

# ----------------------------
# Gateway Token
# ----------------------------
# Use Coolify's SERVICE_PASSWORD_GATEWAY, or persist our own
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    OPENCLAW_GATEWAY_TOKEN=$(cat "$TOKEN_FILE")
    echo "[openclaw] Loaded existing gateway token"
  else
    OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n')
    echo "$OPENCLAW_GATEWAY_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "[openclaw] Generated new gateway token"
  fi
else
  # Persist the token from Coolify for future restarts
  echo "$OPENCLAW_GATEWAY_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
export OPENCLAW_GATEWAY_TOKEN

# ----------------------------
# Generate Config
# ----------------------------
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[openclaw] Generating openclaw.json..."
  
  node -e "
const fs = require('fs');
const config = {
  env: { ZAI_API_KEY: process.env.ZAI_API_KEY || '' },
  gateway: {
    mode: 'local',
    port: parseInt(process.env.OPENCLAW_GATEWAY_PORT) || 3000,
    bind: 'lan',
    controlUi: { enabled: true, allowInsecureAuth: false },
    trustedProxies: ['*'],
    auth: { mode: 'token', token: process.env.OPENCLAW_GATEWAY_TOKEN }
  },
  models: {
    providers: {
      zai: {
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        api: 'openai-completions',
        auth: 'api-key',
        authHeader: true,
        models: [{ id: 'glm-4.7', name: 'GLM-4.7' }]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: 'zai/glm-4.7' },
      workspace: '/root/openclaw-workspace'
    }
  }
};
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2) + '\n');
fs.chmodSync('$CONFIG_FILE', 0o600);
console.log('[openclaw] Config ready');
"
else
  echo "[openclaw] Using existing config"
fi

# ----------------------------
# Display Access Info
# ----------------------------
echo ""
echo "=================================================================="
echo "OpenClaw Gateway Ready"
echo "=================================================================="
echo ""
echo "Token: $OPENCLAW_GATEWAY_TOKEN"
echo "Port:  $OPENCLAW_GATEWAY_PORT"
echo ""
if [ -n "$OPENCLAW_DOMAIN" ]; then
  echo "URL: https://${OPENCLAW_DOMAIN}?token=$OPENCLAW_GATEWAY_TOKEN"
else
  echo "URL: http://localhost:${OPENCLAW_GATEWAY_PORT}?token=$OPENCLAW_GATEWAY_TOKEN"
fi
echo ""
echo "Commands:"
echo "  openclaw-approve  - Approve pending device requests"
echo "  openclaw onboard  - Configure the gateway"
echo ""
echo "=================================================================="

# ----------------------------
# Wait for Docker Proxy
# ----------------------------
if [ -n "$DOCKER_HOST" ]; then
  echo "[openclaw] Waiting for Docker proxy..."
  for i in {1..30}; do
    if curl -sf "$DOCKER_HOST/_ping" > /dev/null 2>&1; then
      echo "[openclaw] Docker proxy ready"
      break
    fi
    sleep 2
  done
fi

# ----------------------------
# Start Gateway
# ----------------------------
ulimit -n 65535 2>/dev/null || true
echo "[openclaw] Starting gateway on port $OPENCLAW_GATEWAY_PORT..."
exec node dist/index.js gateway --bind "${OPENCLAW_GATEWAY_BIND:-lan}" --port "$OPENCLAW_GATEWAY_PORT"
