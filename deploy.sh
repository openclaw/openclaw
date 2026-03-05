#!/bin/bash
set -euo pipefail

# Configuration
REGISTRY_NAME="${REGISTRY_NAME:-asireonclawacr}"
IMAGE_NAME="${IMAGE_NAME:-openclaw}"

# Get the current full commit SHA to match what GitHub Actions uses
SHA=$(git rev-parse HEAD)
IMAGE_TAG="$REGISTRY_NAME.azurecr.io/$IMAGE_NAME:$SHA"

echo "🚀 Building AMD64 Docker image: $IMAGE_TAG"
# Explicitly use linux/amd64 platform to prevent exec format errors when building from Apple Silicon
docker build --platform linux/amd64 -t "$IMAGE_TAG" .

echo "📤 Pushing image to Azure Container Registry..."
docker push "$IMAGE_TAG"

echo "✅ Build and push completed successfully!"
