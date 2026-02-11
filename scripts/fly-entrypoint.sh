#!/bin/bash
# Fly.io entrypoint script
# Sets up symlinks from ephemeral home directories to persistent /data volume

set -e

PERSISTENT_HOME="/data/home"

# Create persistent home directory structure
mkdir -p "$PERSISTENT_HOME/.codex"
mkdir -p "$PERSISTENT_HOME/.config/gh"
mkdir -p "$PERSISTENT_HOME/.config"
mkdir -p "$PERSISTENT_HOME/.ssh"

# Symlink directories that need to persist across restarts
# Format: source (ephemeral) -> target (persistent)

symlink_persistent() {
    local src="$1"
    local dst="$2"

    # Remove existing file/dir if it exists and is not a symlink
    if [ -e "$src" ] && [ ! -L "$src" ]; then
        rm -rf "$src"
    fi

    # Create parent directory if needed
    mkdir -p "$(dirname "$src")"

    # Create symlink if it doesn't exist
    if [ ! -L "$src" ]; then
        ln -sf "$dst" "$src"
        echo "[fly-entrypoint] Linked $src -> $dst"
    fi
}

# Codex CLI config
symlink_persistent "/root/.codex" "$PERSISTENT_HOME/.codex"

# GitHub CLI config
symlink_persistent "/root/.config/gh" "$PERSISTENT_HOME/.config/gh"

# Git config
if [ -f "$PERSISTENT_HOME/.gitconfig" ]; then
    symlink_persistent "/root/.gitconfig" "$PERSISTENT_HOME/.gitconfig"
fi

# SSH keys (if stored)
if [ -d "$PERSISTENT_HOME/.ssh" ] && [ "$(ls -A $PERSISTENT_HOME/.ssh 2>/dev/null)" ]; then
    symlink_persistent "/root/.ssh" "$PERSISTENT_HOME/.ssh"
    chmod 700 "$PERSISTENT_HOME/.ssh"
    chmod 600 "$PERSISTENT_HOME/.ssh"/* 2>/dev/null || true
fi

# OpenClaw wrapper for scripts that expect 'openclaw' in PATH
if [ ! -f /usr/local/bin/openclaw ]; then
    cat > /usr/local/bin/openclaw << 'WRAPPER'
#!/bin/sh
exec node /app/dist/index.js "$@"
WRAPPER
    chmod +x /usr/local/bin/openclaw
    echo "[fly-entrypoint] Created openclaw wrapper"
fi

# Handle one-shot config reset
if [ "${RESET_CONFIG}" = "true" ] || [ "${RESET_CONFIG}" = "1" ]; then
    CONFIG_FILE="${OPENCLAW_STATE_DIR:-/data}/openclaw.json"
    if [ -f "$CONFIG_FILE" ]; then
        echo "[fly-entrypoint] RESET_CONFIG is set; removing existing config..."
        rm -f "$CONFIG_FILE"
    fi
fi

echo "[fly-entrypoint] Persistent storage initialized"

# Start Tailscale if auth key is provided
if [ -n "$TAILSCALE_AUTHKEY" ]; then
    echo "[fly-entrypoint] Starting Tailscale..."

    # Create persistent state directory for Tailscale
    mkdir -p /data/tailscale

    # Start tailscaled in background with persistent state
    tailscaled --state=/data/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock &

    # Wait for tailscaled to be ready
    sleep 2

    # Connect to Tailscale network
    tailscale up --authkey="$TAILSCALE_AUTHKEY" --hostname="clawdbot-fly" --accept-routes

    # Get Tailscale IP
    TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
    if [ -n "$TAILSCALE_IP" ]; then
        echo "[fly-entrypoint] Tailscale connected: $TAILSCALE_IP"
    else
        echo "[fly-entrypoint] Tailscale connection pending..."
    fi
fi

# Sync runtime config from env vars (idempotent, non-fatal)
if [ -f /app/scripts/sync-runtime-config.mjs ]; then
    echo "[fly-entrypoint] Syncing runtime config..."
    OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data}" node /app/scripts/sync-runtime-config.mjs || true
fi

# Start PostgreSQL if data directory exists
if [ -d /data/postgres ] && command -v pg_isready >/dev/null 2>&1; then
    echo "[fly-entrypoint] Starting PostgreSQL..."
    pg_ctlcluster 16 main start 2>/dev/null || true
fi

# Execute the main command
exec "$@"
