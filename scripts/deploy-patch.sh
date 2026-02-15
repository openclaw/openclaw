#!/bin/bash
set -euo pipefail

# Deploy local patched dist to DO droplet
# Usage: ./scripts/deploy-patch.sh
#
# Run this after: npm i -g openclaw@latest on the droplet
# to re-apply our local patches (e.g., fix/multi-bot-startup-ratelimit)

DROPLET="root@159.223.128.170"
SSH_KEY="$HOME/.ssh/id_ed25519_commandery"
LOCAL_DIST="$(dirname "$0")/../dist"
REMOTE_DIST="/usr/lib/node_modules/openclaw/dist/"

if [ ! -d "$LOCAL_DIST" ]; then
  echo "ERROR: dist/ not found. Run 'pnpm build' first."
  exit 1
fi

echo "Building control UI..."
pnpm ui:build 2>&1 | tail -3

echo "Deploying patched dist to droplet..."
rsync -az --delete -e "ssh -i $SSH_KEY" "$LOCAL_DIST/" "$DROPLET:$REMOTE_DIST"

echo "Restarting gateway..."
ssh -i "$SSH_KEY" "$DROPLET" 'systemctl restart openclaw-gateway'

echo "Waiting 45s for staggered bot startup..."
sleep 45

echo "Checking channels..."
ssh -i "$SSH_KEY" "$DROPLET" 'openclaw channels status --probe 2>&1 | grep -cE "running.*works"'
echo "bots running successfully."

echo "Done."
