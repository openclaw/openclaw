#!/usr/bin/env bash
set -euo pipefail

# OpenClaw Runtime Refresh Script
# This script refreshes the runtime from the dev repo on main branch
# The runtime is built to a separate, protected directory that the agent cannot modify

OPENCLAW_STATE_DIR="/var/lib/openclaw"
OPENCLAW_REPO_URL="https://github.com/aron98/openclaw.git"
OPENCLAW_REPO_REF="main"
OPENCLAW_REPO_DIR="/var/lib/openclaw/workspace/openclaw"
OPENCLAW_RUNTIME_DIR="/var/lib/openclaw/runtime"
OPENCLAW_BUILD_MARKER="/var/lib/openclaw/.last-runtime-build"
OPENCLAW_NODE_HEAP_MB=3072

export HOME="${HOME:-$OPENCLAW_STATE_DIR}"
export NODE_OPTIONS="--max-old-space-size=${OPENCLAW_NODE_HEAP_MB}"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Setup user-local npm global directory (for control panel node access)
export NPM_CONFIG_PREFIX="$OPENCLAW_STATE_DIR/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
mkdir -p "$NPM_CONFIG_PREFIX/bin"

# Add homebrew if available (for linuxbrew)
if [ -x "/home/linuxbrew/.linuxbrew/bin/brew" ]; then
  export HOMEBREW_NO_ENV_HINTS=1
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
fi

# Ensure runtime directory exists
mkdir -p "$OPENCLAW_RUNTIME_DIR"

# Clone or update the dev repo (this is where the agent reads source code)
mkdir -p "$(dirname "$OPENCLAW_REPO_DIR")"
if [ ! -d "$OPENCLAW_REPO_DIR/.git" ]; then
  git clone "$OPENCLAW_REPO_URL" "$OPENCLAW_REPO_DIR"
fi

git -C "$OPENCLAW_REPO_DIR" fetch --prune origin
git -C "$OPENCLAW_REPO_DIR" checkout "$OPENCLAW_REPO_REF"
git -C "$OPENCLAW_REPO_DIR" pull --ff-only origin "$OPENCLAW_REPO_REF"

# Check if we need to rebuild
current_rev="$(git -C "$OPENCLAW_REPO_DIR" rev-parse HEAD)"
last_rev=""
if [ -f "$OPENCLAW_BUILD_MARKER" ]; then
  last_rev="$(cat "$OPENCLAW_BUILD_MARKER")"
fi

if [ "$current_rev" != "$last_rev" ] || [ ! -d "$OPENCLAW_RUNTIME_DIR/dist" ]; then
  echo "Building new runtime from $current_rev..."
  
  # Clean old runtime (keep for rollback possibility)
  if [ -d "$OPENCLAW_RUNTIME_DIR/dist" ]; then
    echo "Backing up previous runtime..."
    rm -rf "$OPENCLAW_RUNTIME_DIR/dist.prev"
    mv "$OPENCLAW_RUNTIME_DIR/dist" "$OPENCLAW_RUNTIME_DIR/dist.prev"
  fi
  
  # Copy source to runtime staging area for build
  # We build in runtime dir but source remains in workspace (dev repo)
  rsync -a --exclude='node_modules' --exclude='dist' "$OPENCLAW_REPO_DIR/" "$OPENCLAW_RUNTIME_DIR/"
  
  # Build in runtime directory
  cd "$OPENCLAW_RUNTIME_DIR"
  pnpm install --frozen-lockfile
  pnpm ui:build
  pnpm build
  
  # Protect the runtime when running as root.
  if [ "$(id -u)" -eq 0 ]; then
    chown -R root:openclaw "$OPENCLAW_RUNTIME_DIR/dist"
    chmod -R 755 "$OPENCLAW_RUNTIME_DIR/dist"
  else
    echo "Skipping runtime ownership hardening (requires root)."
  fi
  
  # Mark successful build
  echo "$current_rev" > "$OPENCLAW_BUILD_MARKER"
  
  echo "Runtime built and protected successfully"
else
  echo "Runtime is up to date ($current_rev)"
fi

# Ensure the entry point is executable
chmod +x "$OPENCLAW_RUNTIME_DIR/openclaw.mjs" 2>/dev/null || true
