#!/bin/bash
# Clawdis Gateway Startup Script
# This script ensures the correct Node.js version is used and starts the gateway

set -euo pipefail

# Configuration
NODE_VERSION="v22.21.1"
FNM_BASE="/home/almaz/.local/share/fnm/node-versions"
NODE_PATH="${FNM_BASE}/${NODE_VERSION}/installation/bin"
WORK_DIR="/home/almaz/zoo_flow/clawdis"
LOG_PREFIX="[start-gateway]"

log() {
    echo "${LOG_PREFIX} $(date '+%Y-%m-%d %H:%M:%S') $*"
}

error() {
    echo "${LOG_PREFIX} ERROR: $*" >&2
}

# Verify Node.js installation
if [ ! -d "$NODE_PATH" ]; then
    error "Node.js ${NODE_VERSION} not found at ${NODE_PATH}"
    error "Available versions:"
    ls -la "$FNM_BASE" 2>/dev/null || error "FNM base directory not found"
    exit 1
fi

# Set PATH to include correct Node.js version
export PATH="${NODE_PATH}:$PATH"

# Verify Node.js version
ACTUAL_VERSION=$(node --version 2>/dev/null || echo "unknown")
if [ "$ACTUAL_VERSION" != "$NODE_VERSION" ]; then
    error "Node.js version mismatch: expected ${NODE_VERSION}, got ${ACTUAL_VERSION}"
    exit 1
fi

log "Using Node.js ${ACTUAL_VERSION}"

# Change to working directory
if [ ! -d "$WORK_DIR" ]; then
    error "Working directory not found: ${WORK_DIR}"
    exit 1
fi
cd "$WORK_DIR"

# Load environment from .env if exists (for development)
if [ -f ".env" ]; then
    set -a
    source .env
    set +a
    log "Loaded .env file"
fi

# Verify critical environment variables
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    error "TELEGRAM_BOT_TOKEN not set"
    exit 1
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    error "ANTHROPIC_API_KEY not set"
    exit 1
fi

log "Starting gateway on port 18789..."

# Prefer compiled dist to avoid tsx/esbuild overhead in production.
DIST_ENTRY="${WORK_DIR}/dist/index.js"
if [ -f "$DIST_ENTRY" ]; then
    log "Using compiled gateway entry: ${DIST_ENTRY}"
    exec node "$DIST_ENTRY" gateway --port 18789 --allow-unconfigured
fi

# Fallback to tsx via pnpm (dev mode)
PNPM_PATH="${NODE_PATH}/pnpm"
if [ ! -f "$PNPM_PATH" ]; then
    error "pnpm not found at ${PNPM_PATH}"
    exit 1
fi
log "Compiled entry missing; falling back to pnpm/tsx"
exec "$PNPM_PATH" clawdis gateway --port 18789 --allow-unconfigured
