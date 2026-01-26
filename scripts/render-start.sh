#!/bin/sh
# Render startup script - creates config and starts gateway
set -e

echo "=== Render startup script ==="
echo "CLAWDBOT_STATE_DIR=${CLAWDBOT_STATE_DIR}"
echo "HOME=${HOME}"

# Ensure HOME is set (node user's home is typically /home/node)
if [ -z "${HOME}" ]; then
  HOME="/home/node"
  if [ ! -d "${HOME}" ]; then
    HOME="/tmp"
  fi
  echo "Warning: HOME not set, using ${HOME}"
fi

# Config content
CONFIG_CONTENT='{
  "gateway": {
    "mode": "local",
    "trustedProxies": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}'

# Determine config directory - try in order until one works
# Temporarily disable set -e for permission testing
set +e
CONFIG_DIR=""
CONFIG_FILE=""

# Try CLAWDBOT_STATE_DIR first if set
if [ -n "${CLAWDBOT_STATE_DIR}" ]; then
  mkdir -p "${CLAWDBOT_STATE_DIR}" 2>/dev/null
  if echo "${CONFIG_CONTENT}" > "${CLAWDBOT_STATE_DIR}/clawdbot.json" 2>/dev/null; then
    CONFIG_DIR="${CLAWDBOT_STATE_DIR}"
    CONFIG_FILE="${CLAWDBOT_STATE_DIR}/clawdbot.json"
    echo "Using CLAWDBOT_STATE_DIR: ${CONFIG_DIR}"
  fi
fi

# Try /data/.clawdbot if not set yet
if [ -z "${CONFIG_DIR}" ]; then
  mkdir -p "/data/.clawdbot" 2>/dev/null
  if echo "${CONFIG_CONTENT}" > "/data/.clawdbot/clawdbot.json" 2>/dev/null; then
    CONFIG_DIR="/data/.clawdbot"
    CONFIG_FILE="/data/.clawdbot/clawdbot.json"
    echo "Using /data/.clawdbot: ${CONFIG_DIR}"
  fi
fi

# Final fallback: use HOME (always writable by node user)
if [ -z "${CONFIG_DIR}" ]; then
  CONFIG_DIR="${HOME}/.clawdbot"
  CONFIG_FILE="${CONFIG_DIR}/clawdbot.json"
  mkdir -p "${CONFIG_DIR}"
  echo "${CONFIG_CONTENT}" > "${CONFIG_FILE}"
  echo "Using fallback: ${CONFIG_FILE}"
fi

# Re-enable set -e for the rest of the script
set -e

echo "Config dir: ${CONFIG_DIR}"
echo "Config file: ${CONFIG_FILE}"

echo "=== Config written ==="
echo "=== ${CONFIG_FILE}: ==="
cat "${CONFIG_FILE}"
echo "=== End config ==="

# Verify file exists
echo "=== Verifying config file ==="
if [ -f "${CONFIG_FILE}" ]; then
  echo "Config file exists: ${CONFIG_FILE}"
  ls -la "${CONFIG_FILE}" || true
else
  echo "ERROR: Config file not found: ${CONFIG_FILE}"
  exit 1
fi

# Start the gateway with token from env var
# Explicitly set CLAWDBOT_CONFIG_PATH to ensure config is loaded from the file we wrote
# Also update CLAWDBOT_STATE_DIR to match the directory we're actually using
# Disable config cache to ensure fresh reads
echo "=== Starting gateway ==="
echo "=== Using config dir: ${CONFIG_DIR} ==="
echo "=== Setting CLAWDBOT_STATE_DIR=${CONFIG_DIR} ==="
echo "=== Setting CLAWDBOT_CONFIG_PATH=${CONFIG_FILE} ==="
echo "=== Disabling config cache ==="
export CLAWDBOT_STATE_DIR="${CONFIG_DIR}"
export CLAWDBOT_CONFIG_PATH="${CONFIG_FILE}"
export CLAWDBOT_CONFIG_CACHE_MS=0

# Verify config can be read
echo "=== Verifying config can be read ==="
node -e "
const fs = require('fs');
const path = '${CONFIG_FILE}';
if (fs.existsSync(path)) {
  const content = fs.readFileSync(path, 'utf-8');
  const parsed = JSON.parse(content);
  console.log('Config loaded successfully:');
  console.log('trustedProxies:', JSON.stringify(parsed.gateway?.trustedProxies));
} else {
  console.error('Config file not found:', path);
  process.exit(1);
}
"

exec node dist/index.js gateway \
  --port 8080 \
  --bind lan \
  --auth token \
  --token "$CLAWDBOT_GATEWAY_TOKEN" \
  --allow-unconfigured
