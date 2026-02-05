#!/usr/bin/env bash
set -euo pipefail

# Prefer /data for persistence, but fall back when not writable
OPENCLAW_DATA_DIR=/data
mkdir -p /data/.openclaw 2>/dev/null || true
if [ ! -w /data/.openclaw ]; then
    OPENCLAW_DATA_DIR=/tmp/openclaw
    mkdir -p "$OPENCLAW_DATA_DIR/.openclaw" 2>/dev/null || true
    echo "[entrypoint] /data is not writable; falling back to $OPENCLAW_DATA_DIR"
fi

# Force OpenClaw to use the selected data dir as HOME
export HOME="$OPENCLAW_DATA_DIR"
export OPENCLAW_DATA_DIR

# Config path follows OpenClaw convention: ~/.openclaw/openclaw.json
: "${OPENCLAW_CONFIG_PATH:=${HOME}/.openclaw/openclaw.json}"
export OPENCLAW_CONFIG_PATH

# Use PORT env var from Railway if set, otherwise default to 8080
: "${OPENCLAW_GATEWAY_PORT:=${PORT:-8080}}"
export OPENCLAW_GATEWAY_PORT

# Create directories
mkdir -p "$OPENCLAW_DATA_DIR/.openclaw" "$OPENCLAW_DATA_DIR/workspace" 2>/dev/null || true

# Generate a gateway token if not already set (required for non-loopback binding)
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    # Check if we have a persisted token in config
    if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
        PERSISTED_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG_PATH','utf8'));console.log(c.gateway?.auth?.token||'')}catch(e){}" 2>/dev/null || true)
        if [ -n "$PERSISTED_TOKEN" ]; then
            export OPENCLAW_GATEWAY_TOKEN="$PERSISTED_TOKEN"
            echo "[entrypoint] Using persisted gateway token from config"
        fi
    fi
    # If still no token, generate one
    if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
        export OPENCLAW_GATEWAY_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
        echo "[entrypoint] Generated gateway token for Railway deployment"
    fi
fi

echo "[entrypoint] Token: ${OPENCLAW_GATEWAY_TOKEN:0:8}..."
echo "[entrypoint] Port: $OPENCLAW_GATEWAY_PORT"

# If first arg is "gateway", run it directly with our configured options
if [ "${1:-}" = "gateway" ] || [ "${1:-}" = "node" ]; then
    echo "[entrypoint] Running gateway with explicit bind=lan and token"

    # Force bind mode in config and set up browser profiles
    echo "[entrypoint] Writing config with gateway.bind=lan and browser profiles..."
    node -e "
const fs = require('fs');
const configPath = '$OPENCLAW_CONFIG_PATH';
const dataDir = process.env.OPENCLAW_DATA_DIR || '/data';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

// Gateway config
cfg.gateway = cfg.gateway || {};
cfg.gateway.bind = 'lan';
cfg.gateway.mode = 'local';
cfg.gateway.auth = cfg.gateway.auth || {};
cfg.gateway.auth.token = '$OPENCLAW_GATEWAY_TOKEN';
// Remove invalid key from previous deployment
delete cfg.gateway.customBindHost;

// Browser profiles - persistent sessions on /data volume
cfg.browser = cfg.browser || {};
cfg.browser.profiles = cfg.browser.profiles || {};
cfg.browser.profiles.main = {
  userDataDir: `${dataDir}/browser-profiles/main`,
  headless: true
};
cfg.browser.profiles.google = {
  userDataDir: `${dataDir}/browser-profiles/google`,
  headless: true
};
cfg.browser.profiles.facebook = {
  userDataDir: `${dataDir}/browser-profiles/facebook`,
  headless: true
};
cfg.browser.profiles.instagram = {
  userDataDir: `${dataDir}/browser-profiles/instagram`,
  headless: true
};
cfg.browser.profiles.linkedin = {
  userDataDir: `${dataDir}/browser-profiles/linkedin`,
  headless: true
};
cfg.browser.profiles.tiktok = {
  userDataDir: `${dataDir}/browser-profiles/tiktok`,
  headless: true
};
cfg.browser.profiles.github = {
  userDataDir: `${dataDir}/browser-profiles/github`,
  headless: true
};

// Agent model config - OpenRouter auto routing with Haiku fallback
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
cfg.agents.defaults.model = {
  primary: 'openrouter/openrouter/auto',
  fallbacks: ['openrouter/anthropic/claude-haiku-4.5']
};
cfg.agents.defaults.models = {
  'openrouter/openrouter/auto': {},
  'openrouter/anthropic/claude-haiku-4.5': {}
};

// Enable brain -> muscle -> brain reply pipeline (disabled by default in OpenClaw).
// Brain stays as the configured primary model; muscle defaults to model fallbacks unless overridden.
cfg.agents.defaults.replyPipeline = cfg.agents.defaults.replyPipeline || {};
cfg.agents.defaults.replyPipeline.enabled = true;

fs.mkdirSync(require('path').dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
console.log('[entrypoint] Config written');
console.log('[entrypoint] Browser profiles:', Object.keys(cfg.browser.profiles).join(', '));
"

    # Create browser profile directories
    mkdir -p "$OPENCLAW_DATA_DIR/browser-profiles/main" \
             "$OPENCLAW_DATA_DIR/browser-profiles/google" \
             "$OPENCLAW_DATA_DIR/browser-profiles/facebook" \
             "$OPENCLAW_DATA_DIR/browser-profiles/instagram" \
             "$OPENCLAW_DATA_DIR/browser-profiles/linkedin" \
             "$OPENCLAW_DATA_DIR/browser-profiles/tiktok" \
             "$OPENCLAW_DATA_DIR/browser-profiles/github"

    exec node /app/openclaw.mjs gateway run \
        --bind lan \
        --token "$OPENCLAW_GATEWAY_TOKEN" \
        --port "$OPENCLAW_GATEWAY_PORT" \
        --allow-unconfigured \
        --verbose
fi

# Otherwise run whatever was passed
echo "[entrypoint] Running: $@"
exec "$@"
