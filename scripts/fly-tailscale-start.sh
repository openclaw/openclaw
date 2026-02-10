#!/bin/bash
set -euo pipefail

# Tailscale startup script for fly.io
# This script authenticates Tailscale and then starts the OpenClaw gateway

# Ensure node user exists and has a home directory
# This prevents workspace resolution from defaulting to /root/.openclaw
if ! id -u node >/dev/null 2>&1; then
  echo "Creating node user..."
  useradd -m -u 1000 node || true
fi
if [ ! -d /home/node ]; then
  mkdir -p /home/node
  chown node:node /home/node || true
fi

# Fix permissions for /data directory (mounted volume)
# Ensure node user can read/write to /data
echo "Setting up /data directory permissions..."
mkdir -p /data
chown -R node:node /data || true
chmod -R 755 /data || true

# Ensure OPENCLAW_STATE_DIR is set and exported before any commands run
# This prevents code from defaulting to /root/.openclaw when running as root
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"

# Create necessary subdirectories with correct ownership
# Create workspace directory explicitly - this is where agents store their files
mkdir -p "${OPENCLAW_STATE_DIR}" "${OPENCLAW_STATE_DIR}/workspace" /data/workspace /var/run/tailscale
chown -R node:node "${OPENCLAW_STATE_DIR}" /data/workspace || true
chmod -R 755 "${OPENCLAW_STATE_DIR}" /data/workspace || true
chmod 755 "${OPENCLAW_STATE_DIR}/workspace" || true

# Create symlinks from both root and node user's home .openclaw to OPENCLAW_STATE_DIR
# This ensures workspace resolution (which uses homedir()) works correctly
# even if OPENCLAW_STATE_DIR isn't checked by all code paths or if something runs as root
if [ -d /home/node ] && [ ! -e /home/node/.openclaw ]; then
  ln -s "${OPENCLAW_STATE_DIR}" /home/node/.openclaw || true
  chown -h node:node /home/node/.openclaw || true
fi
# Also create symlink for root user as fallback (in case any code runs as root)
if [ ! -e /root/.openclaw ]; then
  ln -s "${OPENCLAW_STATE_DIR}" /root/.openclaw || true
fi

# On first deploy (no config yet), copy default Fly config so the gateway runs without manual onboarding
CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"
if [ ! -f "${CONFIG_PATH}" ] && [ -f /app/config/fly.default.json ]; then
  echo "No config found; installing default Fly config from /app/config/fly.default.json"
  cp /app/config/fly.default.json "${CONFIG_PATH}"
  chown node:node "${CONFIG_PATH}"
  chmod 600 "${CONFIG_PATH}"
fi

# Function to start gateway with config error handling
# If config is invalid, keeps container alive and exits with code 0 to prevent Fly.io restart
start_gateway_safe() {
  local cmd=("$@")
  echo "Starting OpenClaw gateway: ${cmd[*]}"
  
  # Start gateway in background to monitor for immediate failures
  gosu node env HOME=/home/node OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" "${cmd[@]}" &
  local gateway_pid=$!
  
  # Wait a few seconds to see if gateway starts successfully or fails immediately
  sleep 8
  
  # Check if gateway process is still running
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    # Gateway process died quickly - likely a config error
    wait "$gateway_pid" 2>/dev/null || true
    local exit_code=$?
    
    echo ""
    echo "=========================================="
    echo "ERROR: Gateway failed to start (exit code: $exit_code)"
    echo "=========================================="
    echo ""
    echo "This is likely due to an invalid config file."
    echo "The container will remain running so you can fix the issue."
    echo ""
    echo "To fix:"
    echo "  1. SSH into the container: fly ssh console -a <app-name>"
    echo "  2. Check config: cat \${OPENCLAW_STATE_DIR}/openclaw.json"
    echo "  3. Edit config or use: openclaw config set <path> <value>"
    echo "  4. Run doctor: openclaw doctor --repair"
    echo "  5. Restart the machine: fly machines restart <machine-id> -a <app-name>"
    echo ""
    echo "Container is waiting. Fix the config and restart the machine."
    echo "Exiting with code 0 to prevent Fly.io from restarting this container."
    echo ""
    # Keep container alive for a while so user can see the error and SSH in
    sleep 300  # Wait 5 minutes
    exit 0
  else
    # Gateway started successfully, wait for it
    echo "Gateway started successfully (PID: $gateway_pid)"
    wait "$gateway_pid"
  fi
}

# Check if Tailscale auth key is provided
if [ -z "${TAILSCALE_AUTHKEY:-}" ]; then
  echo "Warning: TAILSCALE_AUTHKEY not set, skipping Tailscale setup"
  # Set HOME for node user to prevent defaulting to /root
  export HOME=/home/node
  # No Tailscale, start gateway with error handling
  start_gateway_safe env HOME=/home/node OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" "$@"
else
  echo "Starting Tailscale..."
  
  # Create Tailscale directories
  # --statedir is required for TailscaleVarRoot (needed for Serve/TLS)
  mkdir -p /data/tailscale-state
  mkdir -p /var/lib/tailscale
  chmod 755 /data/tailscale-state /var/lib/tailscale
  
  # Set Tailscale environment variables for containerized environments
  export TS_STATE_DIR=/data/tailscale-state
  export TS_SOCKET=/var/run/tailscale/tailscaled.sock
  
  # Start tailscaled in the background (runs as root)
  # --statedir is required for TailscaleVarRoot (fixes "no TailscaleVarRoot" error)
  # This sets the var root directory where Tailscale stores runtime files
  tailscaled --statedir=/data/tailscale-state --socket=/var/run/tailscale/tailscaled.sock &
  TAILSCALED_PID=$!
  
  # Wait for tailscaled to be ready
  for i in {1..30}; do
    if [ -S /var/run/tailscale/tailscaled.sock ]; then
      break
    fi
    sleep 1
  done
  
  # Authenticate with the auth key
  # Check if already authenticated to avoid "requires mentioning all" error
  if tailscale status &>/dev/null && ! tailscale status 2>/dev/null | grep -q "Logged out\|not running"; then
    echo "Tailscale already authenticated"
  else
    # Not authenticated - authenticate with auth key
    # Use --reset to clear any existing non-default settings and avoid "requires mentioning all" error
    tailscale up --reset --authkey="${TAILSCALE_AUTHKEY}" --accept-routes=false --accept-dns=false || {
      echo "Warning: tailscale up failed, trying without --reset..."
      # Fallback: try without reset if reset fails (e.g., if already authenticated)
      tailscale up --authkey="${TAILSCALE_AUTHKEY}" --accept-routes=false --accept-dns=false || true
    }
  fi
  
  # Set operator separately (this doesn't trigger "requires mentioning all" error)
  tailscale set --operator=node || echo "Warning: Failed to set operator (may already be set)"
  
  echo "Tailscale connected. Status:"
  tailscale status
  
  # Ensure node user can access the Tailscale socket
  chmod 666 /var/run/tailscale/tailscaled.sock || chmod 755 /var/run/tailscale && chmod 666 /var/run/tailscale/tailscaled.sock || true
  
  # Set HOME for node user to prevent defaulting to /root
  # This ensures workspace resolution uses OPENCLAW_STATE_DIR instead of /root/.openclaw
  export HOME=/home/node
  
  # Start gateway with error handling
  # If config is invalid, keeps container alive and exits with code 0 to prevent Fly.io restart
  start_gateway_safe env HOME=/home/node OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" "$@"
fi
