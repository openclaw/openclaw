#!/bin/bash
set -euo pipefail

# OpenClaw Multi-Architecture Build Script
# Builds amd64 + arm64 images with Playwright browser support

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REGISTRY="${OPENCLAW_REGISTRY:-openclaw}"
TAG="${TAG:-latest}"
LATEST="${LATEST:-false}"
FULL_IMAGE="${REGISTRY}:${TAG}"

echo "=== OpenClaw Multi-Arch Build ==="
echo "Image: ${FULL_IMAGE}"
echo "Platforms: linux/amd64, linux/arm64"
echo ""

# Check if buildx is available
if ! docker buildx version >/dev/null 2>&1; then
    echo "Error: docker buildx not installed"
    echo "Install Docker Buildx: https://docs.docker.com/build/buildx/install/"
    exit 1
fi

# Create builder if not exists
BUILDER_NAME="openclaw-builder"
if ! docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
    echo "Creating buildx builder: ${BUILDER_NAME}"
    docker buildx create --name "${BUILDER_NAME}" --driver docker-container --use
else
    echo "Using existing builder: ${BUILDER_NAME}"
    docker buildx use "${BUILDER_NAME}"
fi

# Bootstrap builder
echo "Bootstrapping builder..."
docker buildx inspect --bootstrap


# Build and push multi-arch image
echo ""
echo "Building multi-arch image with Playwright..."

# Build with specified tag, and also tag as latest if LATEST=true and TAG is not "latest"
BUILD_TAGS=(-t "${FULL_IMAGE}")
if [ "${TAG}" != "latest" ] && [ "${LATEST}" = "true" ]; then
    BUILD_TAGS+=(-t "${REGISTRY}:latest")
fi

docker buildx build \
    --platform linux/amd64,linux/arm64 \
    "${BUILD_TAGS[@]}" \
    -f "$ROOT_DIR/Dockerfile" \
    --build-arg "OPENCLAW_INSTALL_BROWSER=${OPENCLAW_INSTALL_BROWSER:-1}" \
    --push \
    "$ROOT_DIR"

echo ""
echo "=== Build Complete ==="
echo "Image pushed: ${FULL_IMAGE}"
if [ "${TAG}" != "latest" ] && [ "${LATEST}" = "true" ]; then
    echo "Also tagged: ${REGISTRY}:latest"
fi
echo ""
echo "Verify with:"
echo "  docker manifest inspect ${FULL_IMAGE}"
