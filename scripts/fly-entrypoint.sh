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

echo "[fly-entrypoint] Persistent storage initialized"

# Execute the main command
exec "$@"
