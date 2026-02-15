#!/usr/bin/env bash
set -euo pipefail

# Prefer configured state dir (or /data/.openclaw), but fall back when not writable
STATE_DIR_CANDIDATE="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
mkdir -p "$STATE_DIR_CANDIDATE" 2>/dev/null || true
if [ -w "$STATE_DIR_CANDIDATE" ]; then
    OPENCLAW_STATE_DIR="$STATE_DIR_CANDIDATE"
    OPENCLAW_DATA_DIR="$(dirname "$OPENCLAW_STATE_DIR")"
else
    OPENCLAW_DATA_DIR="/tmp/openclaw"
    OPENCLAW_STATE_DIR="$OPENCLAW_DATA_DIR/.openclaw"
    mkdir -p "$OPENCLAW_STATE_DIR" 2>/dev/null || true
    echo "[entrypoint] State dir not writable; falling back to $OPENCLAW_STATE_DIR"
fi

export OPENCLAW_STATE_DIR
export OPENCLAW_DATA_DIR
# Keep legacy env vars aligned for older health checks/tooling.
export CLAWDBOT_STATE_DIR="$OPENCLAW_STATE_DIR"
export MOLTBOT_STATE_DIR="$OPENCLAW_STATE_DIR"

# Force OpenClaw to use the selected data dir as HOME
export HOME="$OPENCLAW_DATA_DIR"

# Config path follows OpenClaw convention: $OPENCLAW_STATE_DIR/openclaw.json
if [ -n "${OPENCLAW_CONFIG_PATH:-}" ]; then
    config_dir="$(dirname "$OPENCLAW_CONFIG_PATH")"
    mkdir -p "$config_dir" 2>/dev/null || true
    if [ ! -w "$config_dir" ]; then
        OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
        echo "[entrypoint] Config dir not writable; using $OPENCLAW_CONFIG_PATH"
    fi
else
    OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
fi

# If the config file exists but is not writable (e.g., owned by root), fall back to /tmp.
if [ -e "$OPENCLAW_CONFIG_PATH" ] && [ ! -w "$OPENCLAW_CONFIG_PATH" ]; then
    OPENCLAW_DATA_DIR="/tmp/openclaw"
    OPENCLAW_STATE_DIR="$OPENCLAW_DATA_DIR/.openclaw"
    OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
    mkdir -p "$OPENCLAW_STATE_DIR" 2>/dev/null || true
    echo "[entrypoint] Config file not writable; falling back to $OPENCLAW_CONFIG_PATH"
fi

export OPENCLAW_STATE_DIR
export OPENCLAW_DATA_DIR
export CLAWDBOT_STATE_DIR="$OPENCLAW_STATE_DIR"
export MOLTBOT_STATE_DIR="$OPENCLAW_STATE_DIR"
export OPENCLAW_CONFIG_PATH
echo "[entrypoint] State dir: $OPENCLAW_STATE_DIR"
echo "[entrypoint] Config path: $OPENCLAW_CONFIG_PATH"

# Use PORT env var from Railway if set, otherwise default to 8080
: "${OPENCLAW_GATEWAY_PORT:=${PORT:-8080}}"
export OPENCLAW_GATEWAY_PORT

# Workspace directory (respect env, but fall back if not writable)
WORKSPACE_DIR_CANDIDATE="${OPENCLAW_WORKSPACE_DIR:-$OPENCLAW_DATA_DIR/workspace}"
mkdir -p "$WORKSPACE_DIR_CANDIDATE" 2>/dev/null || true
if [ ! -w "$WORKSPACE_DIR_CANDIDATE" ]; then
    OPENCLAW_WORKSPACE_DIR="$OPENCLAW_DATA_DIR/workspace"
    mkdir -p "$OPENCLAW_WORKSPACE_DIR" 2>/dev/null || true
    echo "[entrypoint] Workspace not writable; using $OPENCLAW_WORKSPACE_DIR"
else
    OPENCLAW_WORKSPACE_DIR="$WORKSPACE_DIR_CANDIDATE"
fi
export OPENCLAW_WORKSPACE_DIR
echo "[entrypoint] Workspace: $OPENCLAW_WORKSPACE_DIR"

# Create directories
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR" 2>/dev/null || true

# Ensure self-resolve for plugin-sdk (symlink openclaw package into node_modules)
if [ ! -e "/app/node_modules/openclaw" ]; then
    ln -s .. /app/node_modules/openclaw 2>/dev/null || true
fi

# If we intend to drop privileges to the `node` user, ensure the selected state dir is actually
# writable by that user. Some volume mounts don't allow chown; in that case, fall back to /tmp
# so the gateway can start and pass health checks.
if [ "$(id -u)" -eq 0 ] && command -v su >/dev/null 2>&1; then
    chown -R node:node "$OPENCLAW_DATA_DIR" /app 2>/dev/null || true
    if ! su -p -s /bin/sh node -c "test -w \"$OPENCLAW_STATE_DIR\""; then
        echo "[entrypoint] State dir not writable for node; falling back to /tmp"
        OPENCLAW_DATA_DIR="/tmp/openclaw"
        OPENCLAW_STATE_DIR="$OPENCLAW_DATA_DIR/.openclaw"
        OPENCLAW_WORKSPACE_DIR="$OPENCLAW_DATA_DIR/workspace"
        OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
        export OPENCLAW_DATA_DIR
        export OPENCLAW_STATE_DIR
        export OPENCLAW_WORKSPACE_DIR
        export OPENCLAW_CONFIG_PATH
        export CLAWDBOT_STATE_DIR="$OPENCLAW_STATE_DIR"
        export MOLTBOT_STATE_DIR="$OPENCLAW_STATE_DIR"
        export HOME="$OPENCLAW_DATA_DIR"
        mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR" 2>/dev/null || true
        chown -R node:node "$OPENCLAW_DATA_DIR" /app 2>/dev/null || true
        echo "[entrypoint] State dir: $OPENCLAW_STATE_DIR"
        echo "[entrypoint] Config path: $OPENCLAW_CONFIG_PATH"
        echo "[entrypoint] Workspace: $OPENCLAW_WORKSPACE_DIR"
    fi
fi

# Decode persisted Google login state if provided (used by Playwright/Gmail).
GOOGLE_STATE_PATH="$OPENCLAW_STATE_DIR/google-state.json"
if [ -n "${GOOGLE_STATE_B64:-}" ]; then
    echo "[entrypoint] Writing google-state.json from GOOGLE_STATE_B64 into $GOOGLE_STATE_PATH"
    if [ "${#GOOGLE_STATE_B64}" -gt 750000 ]; then
        echo "[entrypoint] GOOGLE_STATE_B64 too large; refusing to start"
        exit 1
    fi
    if echo "$GOOGLE_STATE_B64" | base64 -d >"$GOOGLE_STATE_PATH" 2>/dev/null; then
        chmod 600 "$GOOGLE_STATE_PATH" 2>/dev/null || true
    else
        echo "[entrypoint] Failed to decode GOOGLE_STATE_B64; refusing to start"
        rm -f "$GOOGLE_STATE_PATH" 2>/dev/null || true
        exit 1
    fi
elif [ -f "$GOOGLE_STATE_PATH" ]; then
    echo "[entrypoint] Found existing google-state.json at $GOOGLE_STATE_PATH"
else
    echo "[entrypoint] Warning: no GOOGLE_STATE_B64 provided and no google-state.json found; Gmail web login will be unavailable"
fi

if [ -n "${GOOGLE_STORAGE_STATE_PATH:-}" ] && [ ! -f "${GOOGLE_STORAGE_STATE_PATH}" ]; then
    echo "[entrypoint] GOOGLE_STORAGE_STATE_PATH is set but file is missing: ${GOOGLE_STORAGE_STATE_PATH}"
    exit 1
fi

export GOOGLE_STORAGE_STATE_PATH="${GOOGLE_STORAGE_STATE_PATH:-$GOOGLE_STATE_PATH}"

# Validate storage state JSON if present
if [ -n "${GOOGLE_STORAGE_STATE_PATH}" ] && [ -f "${GOOGLE_STORAGE_STATE_PATH}" ]; then
    if ! P="${GOOGLE_STORAGE_STATE_PATH}" node -e "const fs=require('fs');const p=process.env.P;try{const j=JSON.parse(fs.readFileSync(p,'utf8'));if(!j||typeof j!=='object'){throw new Error('not object')} if(!Array.isArray(j.cookies)){throw new Error('cookies missing')} console.log('[entrypoint] google-state.json validated with', j.cookies.length, 'cookies')}catch(e){console.error('[entrypoint] Invalid google-state.json:', e.message);process.exit(1)}"; then
        exit 1
    fi
elif [ "${GOOGLE_STATE_REQUIRED:-0}" != "0" ]; then
    echo "[entrypoint] GOOGLE_STATE_REQUIRED=1 but no google-state.json available; refusing to start"
    exit 1
fi

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
if [ "${1:-}" = "gateway" ]; then
    echo "[entrypoint] Running gateway with explicit bind=lan and token"

    # Force bind mode in config and set browser defaults
    echo "[entrypoint] Writing config with gateway.bind=lan and browser settings..."
    node - <<'NODE'
const fs = require('fs');
const path = require('path');

const configPath = process.env.OPENCLAW_CONFIG_PATH;
if (!configPath) {
  throw new Error('Missing OPENCLAW_CONFIG_PATH');
}

const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const googleStatePath = process.env.GOOGLE_STORAGE_STATE_PATH || '';

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  cfg = {};
}

// Gateway config
cfg.gateway = cfg.gateway || {};
cfg.gateway.bind = 'lan';
cfg.gateway.mode = 'local';
cfg.gateway.auth = cfg.gateway.auth || {};
cfg.gateway.auth.token = gatewayToken;

const trustedProxiesRaw = (
  process.env.OPENCLAW_GATEWAY_TRUSTED_PROXIES ||
  process.env.CLAWDBOT_GATEWAY_TRUSTED_PROXIES ||
  ''
).trim();
if (trustedProxiesRaw) {
  cfg.gateway.trustedProxies = trustedProxiesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
// Remove invalid key from previous deployment
delete cfg.gateway.customBindHost;

// Browser defaults for Railway
cfg.browser = cfg.browser || {};
cfg.browser.headless = true;
cfg.browser.noSandbox = true;
// Prefer Playwright's managed Chromium when available (Docker builds install it).
if (!cfg.browser.executablePath) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pw = require('playwright');
    const exePath =
      typeof pw?.chromium?.executablePath === 'function' ? pw.chromium.executablePath() : '';
    if (typeof exePath === 'string' && exePath.trim()) {
      cfg.browser.executablePath = exePath.trim();
    }
  } catch {
    // Ignore if playwright isn't installed in this build.
  }
}

// Clean up legacy browser profile keys that are no longer valid.
if (cfg.browser && cfg.browser.profiles) {
  for (const [key, profile] of Object.entries(cfg.browser.profiles)) {
    if (!profile || typeof profile !== 'object') {
      delete cfg.browser.profiles[key];
      continue;
    }
    delete profile.userDataDir;
    delete profile.headless;
    if (typeof profile.color !== 'string') {
      delete cfg.browser.profiles[key];
      continue;
    }
    if (Object.keys(profile).length === 0) {
      delete cfg.browser.profiles[key];
    }
  }
  if (Object.keys(cfg.browser.profiles).length === 0) {
    delete cfg.browser.profiles;
  }
  if (Object.keys(cfg.browser).length === 0) {
    delete cfg.browser;
  }
}

// Agent model config
// Defaults favor a pinned OpenRouter muscle model. Anthropic Opus stays reserved for the Brain pipeline.
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};

const primaryModel = (process.env.OPENCLAW_PRIMARY_MODEL || 'openrouter/moonshotai/kimi-k2').trim();
const fallbacksRaw = (process.env.OPENCLAW_FALLBACK_MODELS || '').trim();
const fallbackModels = fallbacksRaw
  ? fallbacksRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

cfg.agents.defaults.model = {
  primary: primaryModel,
  fallbacks: fallbackModels,
};

// Reduce accidental spend: default thinking to off unless user enables it per-session.
cfg.agents.defaults.thinkingDefault = cfg.agents.defaults.thinkingDefault || 'off';

// Enable brain -> muscle -> brain reply pipeline.
// Brain uses high-level Anthropic reasoning only when explicitly escalated.
// Muscle relies on the configured fallback models (prefer OpenRouter) for execution.
cfg.agents.defaults.replyPipeline = cfg.agents.defaults.replyPipeline || {};
cfg.agents.defaults.replyPipeline.enabled = true;
cfg.agents.defaults.replyPipeline.brainModel = (
  process.env.OPENCLAW_BRAIN_MODEL || 'anthropic/claude-opus-4-6'
).trim();
const muscleRaw = (process.env.OPENCLAW_MUSCLE_MODELS || '').trim();
cfg.agents.defaults.replyPipeline.muscleModels = muscleRaw
  ? muscleRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : (fallbackModels.length > 0 ? fallbackModels : [primaryModel]);

// Ensure all referenced models have a config entry so alias/indexing and per-model options work.
cfg.agents.defaults.models = cfg.agents.defaults.models || {};
for (const ref of [
  primaryModel,
  ...(cfg.agents.defaults.model.fallbacks || []),
  cfg.agents.defaults.replyPipeline.brainModel,
  ...(cfg.agents.defaults.replyPipeline.muscleModels || []),
]) {
  if (typeof ref === 'string' && ref.trim()) {
    cfg.agents.defaults.models[ref.trim()] = cfg.agents.defaults.models[ref.trim()] || {};
  }
}

const muscleModels = cfg.agents.defaults.replyPipeline.muscleModels || [];
const muscleList = muscleModels.length > 0 ? muscleModels.join(', ') : primaryModel;
const fallbackLabel = fallbackModels.length > 0 ? fallbackModels.join(', ') : 'none';
const openRouterKeyState = process.env.OPENROUTER_API_KEY?.trim() ? 'set' : 'missing';
const anthropicKeyState = process.env.ANTHROPIC_API_KEY?.trim() ? 'set' : 'missing';
console.log(
  `[entrypoint] Model defaults: primary=${primaryModel} fallbacks=${fallbackLabel}`,
);
console.log(
  `[entrypoint] Pipeline models: brain=${cfg.agents.defaults.replyPipeline.brainModel} muscle=${muscleList}`,
);
console.log(
  `[entrypoint] API keys: OPENROUTER_API_KEY=${openRouterKeyState} ANTHROPIC_API_KEY=${anthropicKeyState}`,
);

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
console.log('[entrypoint] Config written');
if (cfg.browser && cfg.browser.profiles) {
  console.log('[entrypoint] Browser profiles:', Object.keys(cfg.browser.profiles).join(', '));
}
if (googleStatePath && fs.existsSync(googleStatePath)) {
  console.log('[entrypoint] Playwright storageState set from:', googleStatePath);
}
NODE

    if [ "$(id -u)" -eq 0 ]; then
        chown -R node:node "$OPENCLAW_DATA_DIR" /app 2>/dev/null || true
        if command -v su >/dev/null 2>&1; then
            exec su -p -s /bin/sh node -c "if [ -n \"\$ETSY_SHOP_RSS_URL\" ]; then echo '[entrypoint] Starting RSS watcher sidecar'; RSS_DISABLE_HEALTH_SERVER=1 node /app/dist/rss-watcher.js & fi; exec node /app/openclaw.mjs gateway run --bind lan --token \"$OPENCLAW_GATEWAY_TOKEN\" --port \"$OPENCLAW_GATEWAY_PORT\" --allow-unconfigured --verbose"
        fi
    fi

    if [ -n "${ETSY_SHOP_RSS_URL:-}" ]; then
        echo "[entrypoint] Starting RSS watcher sidecar"
        RSS_DISABLE_HEALTH_SERVER=1 node /app/dist/rss-watcher.js &
    fi

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
