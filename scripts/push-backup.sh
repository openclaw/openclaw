#!/bin/bash
# Push pipbot image to GitHub Container Registry as backup
#
# Usage: ./scripts/push-backup.sh <tag>
# Example: ./scripts/push-backup.sh proxy-v1
#
# Prerequisites:
#   - Docker running locally OR use after fly deploy (pulls from Fly)
#   - Logged into ghcr.io: echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin

set -e

TAG="${1:-latest}"
FLY_IMAGE="registry.fly.io/pipbot-prod:$TAG"
GHCR_IMAGE="ghcr.io/bloom-street/pipbot:$TAG"

echo "==> Pushing backup to GitHub Container Registry"
echo "    Source: $FLY_IMAGE"
echo "    Target: $GHCR_IMAGE"

# Check if we need to pull from Fly first
if ! docker image inspect "$FLY_IMAGE" &>/dev/null; then
    echo "==> Image not local, pulling from Fly registry..."
    fly auth docker
    docker pull "$FLY_IMAGE"
fi

# Tag for GitHub
echo "==> Tagging for GitHub..."
docker tag "$FLY_IMAGE" "$GHCR_IMAGE"

# Push to GitHub
echo "==> Pushing to ghcr.io..."
docker push "$GHCR_IMAGE"

echo "==> Backup complete: $GHCR_IMAGE"
