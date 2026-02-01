#!/bin/bash
# Deploy pipbot image to both Fly.io and GitHub Container Registry
#
# Usage: ./scripts/deploy.sh <tag>
# Example: ./scripts/deploy.sh proxy-v2
#
# This script:
#   1. Builds and pushes to Fly.io registry (primary)
#   2. Pushes a backup copy to GitHub Container Registry
#
# Prerequisites:
#   - fly CLI authenticated
#   - Docker running (for backup push)
#   - Logged into ghcr.io

set -e

TAG="${1:-latest}"

if [ "$TAG" = "latest" ]; then
    echo "Warning: Using 'latest' tag. Consider using a versioned tag like 'proxy-v1'"
    read -p "Continue? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

echo "=========================================="
echo "Deploying pipbot image: $TAG"
echo "=========================================="

# Step 1: Build and push to Fly
echo ""
echo "==> Step 1/2: Building and pushing to Fly.io..."
fly deploy --image-label "$TAG" --build-only --push

# Step 2: Push backup to GitHub (optional, requires Docker)
echo ""
echo "==> Step 2/2: Pushing backup to GitHub Container Registry..."
if command -v docker &>/dev/null; then
    "$SCRIPT_DIR/push-backup.sh" "$TAG"
else
    echo "    Skipping: Docker not available"
    echo "    Run manually later: ./scripts/push-backup.sh $TAG"
fi

echo ""
echo "=========================================="
echo "Deployment complete!"
echo "=========================================="
echo ""
echo "Primary:  registry.fly.io/pipbot-prod:$TAG"
echo "Backup:   ghcr.io/bloom-street/pipbot:$TAG"
echo ""
echo "Next steps:"
echo "  1. Update flyMachines.ts if tag changed"
echo "  2. Run: cd pipbot-server && npx convex dev --once"
echo "  3. New VMs will use the updated image"
