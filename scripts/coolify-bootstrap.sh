#!/usr/bin/env bash
set -e

# OpenClaw Coolify Bootstrap Script
# Handles token generation, config creation, and startup

OPENCLAW_STATE="/root/.openclaw"
CONFIG_FILE="$OPENCLAW_STATE/openclaw.json"
WORKSPACE_DIR="/root/openclaw-workspace"
TOKEN_FILE="$OPENCLAW_STATE/.gateway_token"

# Validate and fix bind value (must be: loopback, lan, tailnet, auto, or custom)
# Docker/Coolify deployments should use "lan" for all interfaces
case "${OPENCLAW_GATEWAY_BIND:-}" in
  loopback|lan|tailnet|auto|custom)
    # Valid value, keep it
    ;;
  0.0.0.0|*)
    # Invalid or empty, default to "lan"
    export OPENCLAW_GATEWAY_BIND="lan"
    ;;
esac

# Create directories
mkdir -p "$OPENCLAW_STATE" "$WORKSPACE_DIR"
chmod 700 "$OPENCLAW_STATE"

# ----------------------------
# Gateway Token Persistence
# ----------------------------
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    OPENCLAW_GATEWAY_TOKEN=$(cat "$TOKEN_FILE")
    echo "[openclaw] Loaded existing gateway token"
  else
    OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n')
    echo "$OPENCLAW_GATEWAY_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "[openclaw] Generated new gateway token: $OPENCLAW_GATEWAY_TOKEN"
  fi
fi

export OPENCLAW_GATEWAY_TOKEN

# ----------------------------
# Generate Config with ZAI Provider
# ----------------------------
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[openclaw] Generating openclaw.json..."
  
  cat > "$CONFIG_FILE" <<EOF
{
  "env": {
    "ZAI_API_KEY": "${ZAI_API_KEY:-}" 
  },
  "gateway": {
    "mode": "local",
    "port": ${OPENCLAW_GATEWAY_PORT:-28471},
    "bind": "$OPENCLAW_GATEWAY_BIND",
    "auth": {
      "mode": "token",
      "token": "$OPENCLAW_GATEWAY_TOKEN"
    }
  },
  "models": {
    "providers": {
      "zai": {
        "baseUrl": "https://api.z.ai/api/coding/paas/v4",
        "api": "openai-completions",
        "auth": "api-key",
        "authHeader": true,
        "models": [
          { "id": "glm-4.7", "name": "GLM-4.7" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "zai/glm-4.7"
      }
    }
  }
}
EOF

  chmod 600 "$CONFIG_FILE"
  echo "[openclaw] Config ready at $CONFIG_FILE"
fi

# ----------------------------
# Banner & Access Info
# ----------------------------
echo ""
echo "=================================================================="
echo "🦞 OpenClaw Gateway is starting..."
echo "=================================================================="
echo ""
echo "🔑 Access Token: $OPENCLAW_GATEWAY_TOKEN"
echo ""
echo "🌍 Port: ${OPENCLAW_GATEWAY_PORT:-28471}"
echo "🔗 Bind: ${OPENCLAW_GATEWAY_BIND:-lan}"
echo ""
echo "=================================================================="

# ----------------------------
# Run OpenClaw Gateway
# ----------------------------
# Note: Using 'openclaw gateway run' which reads config from file
# Config is generated above with correct bind/port values
exec openclaw gateway run
