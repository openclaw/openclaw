#!/bin/bash
set -euo pipefail

# Build script to replace global OpenClaw with local development version

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building OpenClaw..."
pnpm build

echo "Installing locally-built package globally..."

# Try to find openclaw in common global locations
POSSIBLE_PATHS=(
    "/usr/lib/node_modules/openclaw"
    "/usr/local/lib/node_modules/openclaw"
    "$(npm config get prefix)/lib/node_modules/openclaw"
    "$HOME/.npm-global/lib/node_modules/openclaw"
)

GLOBAL_NODE_MODULES=""
for path in "${POSSIBLE_PATHS[@]}"; do
    if [[ -d "$path" ]]; then
        GLOBAL_NODE_MODULES="$path"
        break
    fi
done

if [[ -z "$GLOBAL_NODE_MODULES" ]]; then
    echo "Error: Could not find global OpenClaw installation"
    echo "Searched in: ${POSSIBLE_PATHS[*]}"
    exit 1
fi

echo "Found OpenClaw at: $GLOBAL_NODE_MODULES"

# Kill running gateway to avoid file locks
echo "Stopping any running OpenClaw gateway..."
pkill -f "openclaw.*gateway" 2>/dev/null || true
sleep 1

# Copy dist folder to global location (requires sudo)
echo "Replacing global installation..."
sudo rm -rf "$GLOBAL_NODE_MODULES/dist"
sudo cp -r dist "$GLOBAL_NODE_MODULES/"

# Also copy any other needed files from the package
sudo cp -f package.json "$GLOBAL_NODE_MODULES/"
sudo cp -f openclaw.mjs "$GLOBAL_NODE_MODULES/"

# Copy assets if exists
if [[ -d "assets" ]]; then
    sudo rm -rf "$GLOBAL_NODE_MODULES/assets"
    sudo cp -r assets "$GLOBAL_NODE_MODULES/"
fi

# Copy CHANGELOG and README if they exist
sudo cp -f CHANGELOG.md LICENSE README.md "$GLOBAL_NODE_MODULES/" 2>/dev/null || true

LOCAL_VERSION=$(node -p "require('./package.json').version")
echo "Done! Global OpenClaw v$LOCAL_VERSION installed."
echo "Restart any running OpenClaw processes to use the new version."
echo ""
echo "To restart the gateway:"
echo "  - If using the app: Quit and reopen OpenClaw"
echo "  - If using CLI: pkill -f openclaw-gateway; openclaw gateway run"